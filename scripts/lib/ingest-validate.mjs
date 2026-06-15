// Project 4ward — shared ingestion validation (keyless, no DB, no fs).
// Single source of truth used by ingest-persist.mjs AND test-ingest-validation.mjs, so the adversarial
// tests exercise exactly the logic that runs in production. Mirrors the SQL self-validation in
// migration 0007's ingest_memory_entry (defense in depth).

export const MODEL = 'gemini-embedding-001'
export const KINDS = new Set(['user', 'feedback', 'project', 'reference'])
export const RPC_KEYS = ['name', 'kind', 'title', 'body', 'links', 'source_path', 'embedding_model', 'embedding', 'chunks']
export const ARTIFACT_KEYS = new Set([...RPC_KEYS, 'run_id'])
export const CHUNK_KEYS = new Set(['chunk_index', 'content', 'embedding', 'embedding_model'])
const PATH_RE = /^memory\/[A-Za-z0-9._-]+\.md$/   // strict; no traversal (no "/", "..")
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const NORM_TOL = 1e-3

// Identity rule — MUST match the embed phase and the SQL function.
export const slugify = (f) => f.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// A valid stored vector: parses to a finite 768-array whose L2 norm is non-zero and ~1 (normalized).
export function vecOk(s) {
  let a
  try { a = JSON.parse(s) } catch { return false }
  if (!Array.isArray(a) || a.length !== 768 || !a.every(Number.isFinite)) return false
  const norm = Math.sqrt(a.reduce((acc, x) => acc + x * x, 0))
  return norm > 0 && Math.abs(norm - 1) < NORM_TOL
}

export const stripRunId = (rec) => { const { run_id, ...payload } = rec; return payload }

export function validateRunMeta(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('run.json: not an object')
  for (const k of Object.keys(meta)) if (!['run_id', 'kind', 'embed_counts'].includes(k)) throw new Error(`run.json: unexpected key "${k}"`)
  if (typeof meta.run_id !== 'string' || !meta.run_id) throw new Error('run.json: missing run_id')
  if (meta.kind !== 'memory') throw new Error('run.json: kind must be "memory"')
  const c = meta.embed_counts
  if (!c || typeof c !== 'object') throw new Error('run.json: missing embed_counts')
  for (const k of ['accepted', 'quarantined', 'skipped', 'failed', 'embedded_vectors', 'chunk_rows'])
    if (!Number.isInteger(c[k]) || c[k] < 0) throw new Error(`run.json: bad count "${k}"`)
  return meta
}

export function validateRecord(rec, i, runId) {
  const w = `record ${i} (${rec?.name ?? '?'})`
  if (typeof rec !== 'object' || rec === null) throw new Error(`${w}: not an object`)
  for (const k of Object.keys(rec)) if (!ARTIFACT_KEYS.has(k)) throw new Error(`${w}: unexpected key "${k}"`)
  if (rec.run_id !== runId) throw new Error(`${w}: run_id mismatch (mixed/forged artifact)`)
  if (!SLUG_RE.test(rec.name ?? '')) throw new Error(`${w}: bad name`)
  if (!KINDS.has(rec.kind)) throw new Error(`${w}: bad kind "${rec.kind}"`)
  if (rec.embedding_model !== MODEL) throw new Error(`${w}: bad embedding_model`)
  if (!rec.title) throw new Error(`${w}: missing title`)
  if (!rec.body) throw new Error(`${w}: missing body`)
  if (!Array.isArray(rec.links) || !rec.links.every((l) => typeof l === 'string')) throw new Error(`${w}: links must be string[]`)
  if (typeof rec.source_path !== 'string' || !PATH_RE.test(rec.source_path)) throw new Error(`${w}: bad source_path (must be memory/<file>.md, no traversal)`)
  if (slugify(rec.source_path.slice('memory/'.length)) !== rec.name) throw new Error(`${w}: source_path slug != name`)
  if (!Array.isArray(rec.chunks)) throw new Error(`${w}: chunks must be an array`)
  const hasChunks = rec.chunks.length > 0
  if (hasChunks) {
    if (rec.embedding !== null) throw new Error(`${w}: chunked entry must have null embedding`)
    rec.chunks.forEach((c, j) => {
      if (typeof c !== 'object' || c === null) throw new Error(`${w} chunk ${j}: not an object`)
      for (const k of Object.keys(c)) if (!CHUNK_KEYS.has(k)) throw new Error(`${w} chunk ${j}: unexpected key "${k}"`)
      if (c.chunk_index !== j) throw new Error(`${w}: non-contiguous chunk_index (expected ${j})`)
      if (!c.content) throw new Error(`${w} chunk ${j}: empty content`)
      if (c.embedding_model !== MODEL) throw new Error(`${w} chunk ${j}: bad embedding_model`)
      if (!vecOk(c.embedding)) throw new Error(`${w} chunk ${j}: embedding not normalized-768`)
    })
  } else {
    if (!vecOk(rec.embedding)) throw new Error(`${w}: unchunked entry needs a normalized-768 embedding`)
  }
}

// Count semantics: accepted = entries; chunk_rows = total memory_chunks rows; embedded_vectors =
// one per unchunked entry + one per chunk row (i.e. total embed() calls).
export function reconcileCounts(records, c) {
  if (c.accepted !== records.length) throw new Error(`reconcile: accepted ${c.accepted} != records ${records.length}`)
  const chunkRows = records.reduce((s, r) => s + (r.chunks?.length || 0), 0)
  if (c.chunk_rows !== chunkRows) throw new Error(`reconcile: chunk_rows ${c.chunk_rows} != ${chunkRows}`)
  const unchunked = records.filter((r) => (r.chunks?.length || 0) === 0).length
  if (c.embedded_vectors !== unchunked + chunkRows) throw new Error(`reconcile: embedded_vectors ${c.embedded_vectors} != ${unchunked + chunkRows}`)
}

export const decideStatus = (ok, total) => (ok === 0 ? 'failed' : ok < total ? 'partial' : 'success')
