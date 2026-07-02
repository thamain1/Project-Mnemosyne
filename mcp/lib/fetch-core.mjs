// Mnemosyne — mnemosyne fetch core (pure/injectable, testable keyless). No stdout writes.
// READ path: validate name -> get_memory_entry RPC -> format the full stored body + metadata.
//
// Counterpart to recall: recall returns METADATA so an agent can FIND entries; fetch returns the full BODY
// so it can READ one (and faithfully fold its detail into a revision instead of blind-overwriting). Read-only;
// no operator actor required — same interim LOCAL single-operator model as recall (server holds service-role).

import { slugify, findSecretMatches } from './remember-core.mjs'   // single source of truth for slug + secret scan

export const MAX_NAME_LEN = 80
export const REDACTION = '[REDACTED-SECRET]'
export const MAX_CHARS_CAP = 16000   // hosted MCP clamp (thread 0027 P5-AGENT-DIET); local caller may omit for full body
export const MAX_HEADING_LEN = 200
export const MAX_HEADINGS_LISTED = 50   // thread 0032 P5-FETCH-SCOPE: never dump an unbounded heading list

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
  for (const k of Object.keys(args)) if (k !== 'name' && k !== 'max_chars' && k !== 'heading') throw new Error(`fetch: unexpected argument "${k}"`)
  if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('fetch: "name" must be a non-empty string')
  // Normalize via the same slugify the writers use, so an exact slug from recall is idempotent and a sloppy
  // human-typed name still resolves.
  const name = slugify(args.name)
  if (!name) throw new Error('fetch: "name" slugifies to empty')
  if (name.length > MAX_NAME_LEN) throw new Error(`fetch: name exceeds ${MAX_NAME_LEN} chars`)
  let max_chars
  if (args.max_chars !== undefined) {
    if (typeof args.max_chars !== 'number' || !Number.isInteger(args.max_chars) || args.max_chars < 1 || args.max_chars > MAX_CHARS_CAP) {
      throw new Error(`fetch: "max_chars" must be an integer in [1, ${MAX_CHARS_CAP}]`)
    }
    max_chars = args.max_chars
  }
  let heading
  if (args.heading !== undefined) {
    if (typeof args.heading !== 'string' || !args.heading.trim()) throw new Error('fetch: "heading" must be a non-empty string')
    if (args.heading.length > MAX_HEADING_LEN) throw new Error(`fetch: "heading" exceeds ${MAX_HEADING_LEN} chars`)
    heading = args.heading.trim()
  }
  return { name, max_chars, heading }
}

// Markdown ATX heading line: 1-6 leading '#' + space + title. Memory bodies are markdown, so this is
// the natural "section" unit (thread 0032 P5-FETCH-SCOPE).
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm

function extractHeadings(text) {
  const out = []
  let m
  HEADING_RE.lastIndex = 0
  while ((m = HEADING_RE.exec(text)) !== null) out.push({ level: m[1].length, title: m[2], index: m.index })
  return out
}

// First heading whose title CONTAINS `needle` (case-insensitive substring, first match wins — never
// guess beyond that). The section runs from that heading through (but not including) the next heading
// at the SAME OR SHALLOWER level, so nested sub-headings stay inside their parent's section — standard
// markdown-section semantics. Not found -> the full heading list (capped/joined by the caller), so the
// caller can build a "never guess" structured error.
function extractSection(text, needle) {
  const headings = extractHeadings(text)
  const lowerNeedle = needle.toLowerCase()
  const idx = headings.findIndex((h) => h.title.toLowerCase().includes(lowerNeedle))
  if (idx === -1) return { found: false, headings: headings.map((h) => h.title) }
  const match = headings[idx]
  let end = text.length
  for (let i = idx + 1; i < headings.length; i++) {
    if (headings[i].level <= match.level) { end = headings[i].index; break }
  }
  return { found: true, text: text.slice(match.index, end).trimEnd() }
}

// Truncate an already-assembled (already-redacted) string as the LAST step — truncating before
// redaction could split a secret span across the cut and defeat pattern matching (thread 0027 build
// instruction #1). Appends an explicit marker rather than silently cutting (honest-truncation rule).
export function truncateFormatted(text, maxChars) {
  if (maxChars === undefined || text.length <= maxChars) return { text, truncated: false }
  const marker = `\n…[truncated at ${maxChars} chars]`
  // guarantee the output length invariant even when maxChars is too small to fit the marker itself
  if (marker.length >= maxChars) return { text: marker.slice(0, maxChars), truncated: true }
  return { text: text.slice(0, maxChars - marker.length) + marker, truncated: true }
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

// Orchestrate: validate -> get_memory_entry RPC -> format/section (with egress redaction) -> truncate
// (last). rpc injectable. max_chars is optional (omitted = full body, the existing local behavior).
// heading is optional (thread 0032 P5-FETCH-SCOPE): when given, returns ONLY that markdown section
// instead of the full formatted entry (metadata header + full body). Redaction ALWAYS runs on the full
// body before sectioning — slicing an unredacted body could split a secret span across the section cut
// and defeat pattern matching (same discipline as redact-before-truncate). An unmatched heading is a
// structured, never-guess error whose heading list is built from the ALREADY-REDACTED body — headings
// are user-controlled text and can themselves contain a secret pattern.
export async function runFetch(args, { rpc }) {
  const { name, max_chars, heading } = validateFetchArgs(args)
  const { data, error } = await rpc('get_memory_entry', { p_name: name })
  if (error) throw new Error(`get_memory_entry error: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data   // table-returning RPC → array of rows
  if (!row) return `No memory entry named "${name}". Use recall to find the right name, or remember to create it.`

  let formatted
  if (heading !== undefined) {
    const redactedBody = redactSecrets(row.body).text
    const section = extractSection(redactedBody, heading)
    if (!section.found) {
      const capped = section.headings.slice(0, MAX_HEADINGS_LISTED)
      const more = section.headings.length > MAX_HEADINGS_LISTED ? ` (+${section.headings.length - MAX_HEADINGS_LISTED} more)` : ''
      throw new Error(`fetch: heading "${heading}" not found in "${name}" — available headings: ${capped.length ? capped.join(' | ') : '(none)'}${more}`)
    }
    formatted = section.text
  } else {
    formatted = formatEntry(row)
  }

  const { text } = truncateFormatted(formatted, max_chars)
  return text
}
