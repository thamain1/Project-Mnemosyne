// Mnemosyne — mnemosyne fetch core (pure/injectable, testable keyless). No stdout writes.
// READ path: validate name -> get_memory_entry RPC -> format the full stored body + metadata.
//
// Counterpart to recall: recall returns METADATA so an agent can FIND entries; fetch returns the full BODY
// so it can READ one (and faithfully fold its detail into a revision instead of blind-overwriting). Read-only;
// no operator actor required — same interim LOCAL single-operator model as recall (server holds service-role).

import { slugify, findSecretMatches } from './remember-core.mjs'   // single source of truth for slug + secret scan

export const MAX_NAME_LEN = 80
export const REDACTION = '[REDACTED-SECRET]'

// EGRESS secret scan (Aegis 0022 #2). The store is meant to be secret-free (scanned on ingress), but ingress
// scanning is not a guarantee — incident 0006 showed contamination can slip in via other paths. So before
// returning ANY body/title text, redact secret-like spans (reusing the writers' findSecretMatches, the single
// pattern source). Right-to-left replacement keeps indices valid. Returns { text, count } of spans redacted.
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', count: 0 }
  const spans = findSecretMatches(text)
  if (!spans.length) return { text, count: 0 }
  let out = text
  for (const s of spans.slice().sort((a, b) => b.index - a.index)) {
    out = out.slice(0, s.index) + REDACTION + out.slice(s.index + s.value.length)
  }
  return { text: out, count: spans.length }
}

// Strict, bounded arg validation (no coercion), mirroring the recall/remember slices.
export function validateFetchArgs(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('fetch: arguments must be an object')
  for (const k of Object.keys(args)) if (k !== 'name') throw new Error(`fetch: unexpected argument "${k}"`)
  if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('fetch: "name" must be a non-empty string')
  // Normalize via the same slugify the writers use, so an exact slug from recall is idempotent and a sloppy
  // human-typed name still resolves.
  const name = slugify(args.name)
  if (!name) throw new Error('fetch: "name" slugifies to empty')
  if (name.length > MAX_NAME_LEN) throw new Error(`fetch: name exceeds ${MAX_NAME_LEN} chars`)
  return { name }
}

// Render the full entry: header (title + classification + provenance + freshness + links) then the body.
// title + body are egress-redacted; if anything was redacted, a leading warning is prepended (so a caller
// never silently consumes contaminated content, and the contamination is visible for cleanup).
export function formatEntry(row) {
  if (!row) return null
  const t = redactSecrets(row.title)
  const b = redactSecrets(row.body)
  const redacted = t.count + b.count
  const warn = redacted ? `⚠️ ${redacted} secret-like span(s) REDACTED on read — this entry is contaminated and should be cleaned (secrets belong in the vault, not the brain).\n\n` : ''
  const links = Array.isArray(row.links) && row.links.length
    ? `\nlinks: ${row.links.map((l) => `[[${l}]]`).join(' ')}` : ''
  return `${warn}# ${t.text}\nname: ${row.name} · kind: ${row.kind} · sensitivity: ${row.sensitivity}\n` +
    `source: ${row.source_path} · updated: ${row.updated_at}${links}\n\n${b.text}`
}

// Orchestrate: validate -> get_memory_entry RPC -> format (with egress redaction). rpc injectable.
export async function runFetch(args, { rpc }) {
  const { name } = validateFetchArgs(args)
  const { data, error } = await rpc('get_memory_entry', { p_name: name })
  if (error) throw new Error(`get_memory_entry error: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data   // table-returning RPC → array of rows
  if (!row) return `No memory entry named "${name}". Use recall to find the right name, or remember to create it.`
  return formatEntry(row)
}
