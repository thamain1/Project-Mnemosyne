// Project 4ward — 4ward-brain remember core (pure/injectable, testable keyless). No stdout writes.
// WRITE path: validate args -> secret-scan -> embed (RETRIEVAL_DOCUMENT) -> build record ->
// reuse the hardened `ingest_memory_entry` RPC (migration 0007; service_role-only; self-validating).
// Shared by server.mjs (real fetch + supabase.rpc) and test-remember.mjs (mocks).
//
// CREDENTIAL/SCOPE: interim LOCAL single-operator only (server holds Gemini + service-role). `remember`
// is a WRITE tool — separate gated unit from the read path. Embedding sends content to Google's API, so
// we secret-scan and REFUSE secret-bearing content (incident 0006 prevention): secrets belong in the
// vault, never embedded into the shared brain.

import { MODEL, DIMS, toVecLiteral } from './recall-core.mjs'

export const KINDS = new Set(['user', 'feedback', 'project', 'reference'])
export const MAX_TITLE_LEN = 300
export const MAX_BODY_LEN = 200_000
export const CHUNK_THRESHOLD = 8000, CHUNK_SIZE = 6000, CHUNK_OVERLAP = 500

// Identity rule — MUST match scripts/lib/ingest-validate.mjs slugify + the SQL RPC.
export const slugify = (f) => f.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// Secret scan — mirrors scripts/ingest-embed.mjs SECRET_PATTERNS. Content embeds via Google's API, so any
// secret-bearing remember is refused (not stored, not sent).
const SECRET_PATTERNS = [
  /sk_(live|test)_[A-Za-z0-9]{8,}/, /\bsbp_[A-Za-z0-9]{20,}/, /\bsb_(secret|publishable)_[A-Za-z0-9_]+/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/, /AIza[0-9A-Za-z_\-]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bghp_[A-Za-z0-9]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[baprs]-[A-Za-z0-9-]{8,}/,
  /\b(api[_-]?key|secret|password|passwd|service_role|access_token|bearer)\b\s*[:=]\s*['"]?\S{8,}/i,
]
export function scanSecret(text) {
  for (const re of SECRET_PATTERNS) if (re.test(text)) return `content matches /${re.source.slice(0, 22)}…/`
  return null
}

// Strict, bounded arg validation (no coercion), mirroring the recall slice's discipline.
export function validateRememberArgs(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('remember: arguments must be an object')
  for (const k of Object.keys(args)) if (!['title', 'body', 'kind', 'name'].includes(k)) throw new Error(`remember: unexpected argument "${k}"`)
  if (typeof args.title !== 'string' || !args.title.trim()) throw new Error('remember: "title" must be a non-empty string')
  if (args.title.length > MAX_TITLE_LEN) throw new Error(`remember: "title" exceeds ${MAX_TITLE_LEN} characters`)
  if (typeof args.body !== 'string' || !args.body.trim()) throw new Error('remember: "body" must be a non-empty string')
  if (args.body.length > MAX_BODY_LEN) throw new Error(`remember: "body" exceeds ${MAX_BODY_LEN} characters`)
  if (typeof args.kind !== 'string' || !KINDS.has(args.kind)) throw new Error(`remember: "kind" must be one of ${[...KINDS].join(', ')}`)
  let name
  if (args.name !== undefined) {
    if (typeof args.name !== 'string') throw new Error('remember: "name" must be a string')
    name = slugify(args.name)
    if (!name) throw new Error('remember: "name" slugifies to empty')
  } else {
    name = slugify(args.title)
    if (!name) throw new Error('remember: "title" slugifies to empty — provide an explicit "name"')
  }
  return { title: args.title.trim(), body: args.body.trim(), kind: args.kind, name }
}

export function chunkBody(body) {
  if (body.length <= CHUNK_THRESHOLD) return [body]
  const out = []
  for (let i = 0; i < body.length; i += CHUNK_SIZE - CHUNK_OVERLAP) out.push(body.slice(i, i + CHUNK_SIZE))
  return out
}
export const extractLinks = (b) => [...new Set([...b.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim()))]

// Document embedder (RETRIEVAL_DOCUMENT) — stored-content counterpart of recall's RETRIEVAL_QUERY embedder.
// Same AbortController timeout + bounded retry policy. Reuses toVecLiteral (finite/normalized/768 → literal).
export function makeEmbedDoc({ apiKey, fetchImpl = fetch, sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 15000, maxAttempts = 5 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`
  async function attempt(text) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      let res
      try {
        res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify({ content: { parts: [{ text }] }, taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: DIMS }), signal: ctrl.signal })
      } catch (e) {
        const err = new Error(e?.name === 'AbortError' ? 'embed request timeout' : `embed request failed: ${e?.message ?? e}`)
        err.retryable = true
        throw err
      }
      if (!res.ok) {
        const body = await res.text()
        const err = new Error(`embed ${res.status}: ${body}`)
        err.retryable = res.status === 429 || res.status >= 500
        throw err
      }
      return toVecLiteral((await res.json())?.embedding?.values)
    } finally {
      clearTimeout(timer)
    }
  }
  return async function embedDoc(text) {
    for (let a = 1; a <= maxAttempts; a++) {
      try { return await attempt(text) }
      catch (e) { if (e?.retryable && a < maxAttempts) { await sleepImpl(a * 1500); continue } throw e }
    }
    throw new Error('embed: exhausted retries')
  }
}

// Build the ingest_memory_entry payload (matches scripts/lib/ingest-validate.mjs RPC_KEYS + the SQL RPC):
// synthesized source_path = memory/<name>.md so the hardened RPC's strict path/slug check passes.
export async function buildRecord({ title, body, kind, name }, embedDoc) {
  const parts = chunkBody(body)
  const rec = { name, kind, title, body, links: extractLinks(body), source_path: `memory/${name}.md`, embedding_model: MODEL, embedding: null, chunks: [] }
  if (parts.length === 1) {
    rec.embedding = await embedDoc(`${title}\n\n${parts[0]}`)
  } else {
    for (let i = 0; i < parts.length; i++) rec.chunks.push({ chunk_index: i, content: parts[i], embedding: await embedDoc(parts[i]), embedding_model: MODEL })
  }
  return rec
}

// Orchestrate: validate -> secret-scan -> embed -> ingest_memory_entry RPC. embedDoc/rpc injectable.
export async function runRemember(args, { embedDoc, rpc }) {
  const { title, body, kind, name } = validateRememberArgs(args)
  const reason = scanSecret(`${title}\n${body}`)
  if (reason) throw new Error(`remember refused: ${reason} — secrets must never be stored in the brain (use the vault)`)
  const record = await buildRecord({ title, body, kind, name }, embedDoc)
  const { error } = await rpc('ingest_memory_entry', { payload: record })
  if (error) throw new Error(`ingest_memory_entry error: ${error.message}`)
  const shape = record.chunks.length ? `${record.chunks.length} chunks` : '1 vector'
  return `Remembered "${title}" as ${name} (${kind}, ${shape}). source: ${record.source_path}`
}
