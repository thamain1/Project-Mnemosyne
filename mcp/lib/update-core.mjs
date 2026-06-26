// Mnemosyne — mnemosyne update core (pure/injectable, testable keyless). No stdout writes.
// WRITE path: validate args -> secret-scan -> bound fan-out -> embed (RETRIEVAL_DOCUMENT) -> build payload
// -> ATOMIC update_memory RPC (migration 0021). The RPC locks the target row, asserts the caller's
// expected_updated_at (optimistic concurrency), snapshots prior state to memory_versions, applies the new
// content + re-embedding, reconciles chunks, and writes an audit row — all in ONE transaction.
//
// CREDENTIAL/SCOPE: interim LOCAL single-operator only (server holds Gemini + service-role). Unlike remember
// (which only writes its own mcp/ namespace), update CAN revise a canonical memory/ entry — that's the point:
// fold an old entry's detail into a faithful revision. Every update is versioned + reversible, and provenance
// (source_path) is immutable. Embedding sends content to Google, so we secret-scan + REFUSE secrets (0006).
//
// Reuses remember-core's validators / secret scan / chunker / embedder so there is ONE source of truth.

import { MODEL } from './recall-core.mjs'
import {
  KINDS, MAX_TITLE_LEN, MAX_BODY_LEN, MAX_NAME_LEN, MAX_CHUNKS,
  slugify, scanSecret, chunkBody, extractLinks, isUuid,
} from './remember-core.mjs'

export const MAX_CHANGE_REASON_LEN = 1000

export function validateUpdateArgs(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('update: arguments must be an object')
  for (const k of Object.keys(args)) {
    if (!['name', 'title', 'body', 'kind', 'change_reason', 'expected_updated_at'].includes(k)) throw new Error(`update: unexpected argument "${k}"`)
  }
  if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('update: "name" must be a non-empty string (the slug of the entry to revise)')
  const name = slugify(args.name)
  if (!name) throw new Error('update: "name" slugifies to empty')
  if (name.length > MAX_NAME_LEN) throw new Error(`update: name exceeds ${MAX_NAME_LEN} chars`)
  if (typeof args.title !== 'string' || !args.title.trim()) throw new Error('update: "title" must be a non-empty string')
  if (args.title.length > MAX_TITLE_LEN) throw new Error(`update: "title" exceeds ${MAX_TITLE_LEN} characters`)
  if (typeof args.body !== 'string' || !args.body.trim()) throw new Error('update: "body" must be a non-empty string')
  if (args.body.length > MAX_BODY_LEN) throw new Error(`update: "body" exceeds ${MAX_BODY_LEN} characters`)
  if (typeof args.kind !== 'string' || !KINDS.has(args.kind)) throw new Error(`update: "kind" must be one of ${[...KINDS].join(', ')}`)
  let change_reason
  if (args.change_reason !== undefined) {
    if (typeof args.change_reason !== 'string') throw new Error('update: "change_reason" must be a string')
    if (args.change_reason.length > MAX_CHANGE_REASON_LEN) throw new Error(`update: "change_reason" exceeds ${MAX_CHANGE_REASON_LEN} chars`)
    change_reason = args.change_reason.trim() || undefined
  }
  // expected_updated_at = optimistic-concurrency token (the updated_at the caller saw via fetch). MANDATORY
  // (Aegis 0022 #1): there is no "accept current state" opt-out, so you must fetch before you update — a blind
  // overwrite is structurally impossible. Must be a real ISO timestamp.
  if (typeof args.expected_updated_at !== 'string' || !args.expected_updated_at.trim()) {
    throw new Error('update: "expected_updated_at" is required — fetch the entry first and pass the updated_at you saw (ISO timestamp string)')
  }
  if (Number.isNaN(Date.parse(args.expected_updated_at))) throw new Error('update: "expected_updated_at" must be a valid ISO timestamp')
  const expected_updated_at = args.expected_updated_at
  return { name, title: args.title.trim(), body: args.body.trim(), kind: args.kind, change_reason, expected_updated_at }
}

// Build the update_memory payload — same shape as remember's buildRecord MINUS source_path (provenance is
// immutable on update; the RPC keeps the existing row's source_path). Single embedding mirrors remember's
// `${title}\n\n${body}` strategy so updated vectors stay consistent with how the entry was first embedded.
export async function buildUpdatePayload({ title, body, kind, name }, embedDoc) {
  const parts = chunkBody(body)
  const rec = { name, kind, title, body, links: extractLinks(body), embedding_model: MODEL, embedding: null, chunks: [] }
  if (parts.length === 1) {
    rec.embedding = await embedDoc(`${title}\n\n${parts[0]}`)
  } else {
    for (let i = 0; i < parts.length; i++) rec.chunks.push({ chunk_index: i, content: parts[i], embedding: await embedDoc(parts[i]), embedding_model: MODEL })
  }
  return rec
}

// Orchestrate: actor-gate -> validate -> secret-scan -> bound fan-out -> embed -> ATOMIC update_memory RPC.
export async function runUpdate(args, { embedDoc, rpc, actorId }) {
  if (!isUuid(actorId)) throw new Error('update: no valid operator actor configured (OPERATOR_MEMBER_ID) — refusing to write')
  const { name, title, body, kind, change_reason, expected_updated_at } = validateUpdateArgs(args)
  // refuse secrets BEFORE any embed call (incident 0006). change_reason isn't embedded but is stored, so scan it too.
  const reason = scanSecret(`${title}\n${body}`) || (change_reason && scanSecret(change_reason) && 'secret-like change_reason')
  if (reason) throw new Error(`update refused: ${reason} — secrets must never be stored in the brain (use the vault)`)
  // bound fan-out BEFORE any embed call so oversized input can't partially transmit to Google (Aegis 0007 #3)
  const partCount = chunkBody(body).length
  if (partCount > MAX_CHUNKS) throw new Error(`update: content too large (${partCount} chunks > max ${MAX_CHUNKS})`)
  const payload = await buildUpdatePayload({ title, body, kind, name }, embedDoc)
  const audit = { kind, chunks: payload.chunks.length }   // safe metadata only — never the body
  if (change_reason) audit.change_reason = change_reason
  const { data, error } = await rpc('update_memory', { p_payload: payload, p_actor: actorId, p_audit: audit, p_expected_updated_at: expected_updated_at })
  if (error) throw new Error(`update_memory error: ${error.message}`)
  const info = data || {}
  const shape = payload.chunks.length ? `${payload.chunks.length} chunks` : '1 vector'
  return `Updated "${title}" (${name}, ${kind}, ${shape}). Prior state saved as version ${info.version_no ?? '?'} — reversible.`
}
