// Mnemosyne — mnemosyne recall core (pure/injectable, so it's testable keyless).
// Shared by server.mjs (real fetch + supabase.rpc) and test-recall.mjs (mocks). No stdout writes.

import { isUuid } from './remember-core.mjs'

export const MODEL = 'gemini-embedding-001'
export const DIMS = 768
export const MAX_QUERY_LEN = 2000
export const MAX_K = 50
export const DEFAULT_K = 8
export const KINDS = ['user', 'feedback', 'project', 'reference']

// Strict, bounded tool-argument validation (Aegis recall #3): no String()/parseInt() coercion.
// Thread 0032 P1-HYBRID: gained optional kind/project_id/client_id/deal_id filters — same filters
// recall_memory_hybrid accepts, applied BEFORE ranking on the DB side.
export function validateArgs(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('recall: arguments must be an object')
  for (const key of Object.keys(args)) if (!['query', 'k', 'kind', 'project_id', 'client_id', 'deal_id'].includes(key)) throw new Error(`recall: unexpected argument "${key}"`)
  if (typeof args.query !== 'string') throw new Error('recall: "query" must be a string')
  const query = args.query.trim()
  if (!query) throw new Error('recall: "query" must be a non-empty string')
  if (query.length > MAX_QUERY_LEN) throw new Error(`recall: "query" exceeds ${MAX_QUERY_LEN} characters`)
  let k = DEFAULT_K
  if (args.k !== undefined) {
    if (typeof args.k !== 'number' || !Number.isInteger(args.k) || args.k < 1 || args.k > MAX_K) {
      throw new Error(`recall: "k" must be an integer in [1, ${MAX_K}]`)
    }
    k = args.k
  }
  let kind
  if (args.kind !== undefined) {
    if (typeof args.kind !== 'string' || !KINDS.includes(args.kind)) throw new Error(`recall: "kind" must be one of ${KINDS.join(', ')}`)
    kind = args.kind
  }
  let project_id, client_id, deal_id
  for (const [key, setter] of [['project_id', (v) => (project_id = v)], ['client_id', (v) => (client_id = v)], ['deal_id', (v) => (deal_id = v)]]) {
    if (args[key] !== undefined) {
      if (!isUuid(args[key])) throw new Error(`recall: "${key}" must be a uuid`)
      setter(args[key])
    }
  }
  return { query, k, kind, project_id, client_id, deal_id }
}

// Normalize a finite 768-vector to a pgvector literal; reject zero/degenerate norm.
export function toVecLiteral(values) {
  if (!Array.isArray(values) || values.length !== DIMS || !values.every(Number.isFinite)) {
    throw new Error(`bad query embedding (len ${values?.length})`)
  }
  const norm = Math.sqrt(values.reduce((s, x) => s + x * x, 0))
  if (!(norm > 0)) throw new Error('query embedding has zero norm')
  return '[' + values.map((x) => x / norm).join(',') + ']'
}

// Factory for the query embedder. fetchImpl/sleepImpl injectable for tests; AbortController bounds each
// request (Aegis recall #4); bounded retries on network / 429 / 5xx, fail-fast on other 4xx / bad data.
export function makeEmbedQuery({ apiKey, fetchImpl = fetch, sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 15000, maxAttempts = 5 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`
  async function attempt(text) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      let res
      try {
        res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify({ content: { parts: [{ text }] }, taskType: 'RETRIEVAL_QUERY', outputDimensionality: DIMS }), signal: ctrl.signal })
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
      const values = (await res.json())?.embedding?.values
      return toVecLiteral(values) // throws (non-retryable) on bad/zero vector
    } finally {
      clearTimeout(timer)
    }
  }
  return async function embedQuery(text) {
    for (let a = 1; a <= maxAttempts; a++) {
      try { return await attempt(text) }
      catch (e) { if (e?.retryable && a < maxAttempts) { await sleepImpl(a * 1500); continue } throw e }
    }
    throw new Error('embed: exhausted retries')
  }
}

export function formatResults(query, rows) {
  if (!rows?.length) return `No matches for: ${query}`
  const lines = rows.map((r, i) =>
    `${i + 1}. [${Number(r.similarity).toFixed(3)}] ${r.name} (${r.kind}) — ${r.title}\n   source: ${r.source_path} · updated: ${r.updated_at} · via: ${r.matched_via}`)
  return `Top ${rows.length} for "${query}":\n\n${lines.join('\n')}`
}

// Postgres/PostgREST error shapes for "this function doesn't exist (yet)" — covers both a raw
// undefined-function error (42883) and PostgREST's schema-cache miss wording.
const MISSING_FUNCTION_RE = /42883|schema cache|does not exist|could not find/i

// Orchestrate: validate -> embed -> recall_memory_hybrid RPC -> format. embedQuery/rpc injectable.
// Thread 0032 P1-HYBRID: calls the NEW recall_memory_hybrid (raw query text + embedding + filters,
// RRF-fused vector+FTS) instead of the old pure-vector recall_memory. Falls back to recall_memory if
// the hybrid function isn't found — this is deliberately MORE defensive than the hosted endpoint
// needs to be: the hosted path is gated by a real push/deploy step (safe to switch outright once
// migration 0027 is applied), but this LOCAL stdio server has no such gate — editing this file takes
// effect the moment the MCP client next reconnects, on WHATEVER machine has it configured, regardless
// of whether migration 0027 has been applied to that machine's target DB yet. The fallback makes this
// code safe to have on disk at any point relative to the migration, and it self-upgrades to hybrid
// the moment the function exists — no second manual "switch" step needed for this path.
//
// Fix round (Aegis post-build QC, 2026-07-02 — non-blocking note, adopted as the stricter fix): the
// fallback above is fine for an UNFILTERED query (recall_memory has no filters to lose). But if the
// caller asked for a filtered query (kind/project_id/client_id/deal_id) and the hybrid function is
// missing, silently falling back to unfiltered recall_memory would return real-looking results that
// quietly ignore every filter the caller asked for — a correctness lie to the calling agent, not a
// degraded-but-honest result. So: filtered queries get a structured error instead of a silent
// fallback; only genuinely unfiltered queries fall back.
export async function runRecall(args, { embedQuery, rpc }) {
  const { query, k, kind, project_id, client_id, deal_id } = validateArgs(args)
  const hasFilter = kind !== undefined || project_id !== undefined || client_id !== undefined || deal_id !== undefined
  const query_embedding = await embedQuery(query)
  let { data, error } = await rpc('recall_memory_hybrid', {
    p_query: query, p_embedding: query_embedding, p_match_count: k,
    p_kind: kind ?? null, p_project_id: project_id ?? null, p_client_id: client_id ?? null, p_deal_id: deal_id ?? null,
  })
  if (error && MISSING_FUNCTION_RE.test(error.message || '')) {
    if (hasFilter) {
      throw new Error('recall: hybrid recall (needed for kind/project_id/client_id/deal_id filters) is not yet available on this database — retry without filters, or wait for migration 0027 to apply')
    }
    ;({ data, error } = await rpc('recall_memory', { query_embedding, match_count: k }))
  }
  if (error) throw new Error(`recall error: ${error.message}`)
  return formatResults(query, data)
}
