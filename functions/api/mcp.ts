// Mnemosyne — hosted remote MCP server (thread 0027, P1-HOSTED-MCP + P1-BRIEF). CF Pages Function.
//
// Single stateless Streamable-HTTP endpoint (POST /api/mcp). Any teammate/agent adds ONE url + ONE
// revocable bearer token — zero install, zero service-role-key distribution (the exact SPOF this
// project exists to kill). service_role + GEMINI env live HERE only; the token model is opaque
// server-verified hashes (mnk_...), NOT Supabase JWTs — Streamable-HTTP clients attach a static
// header and there is no client-side refresh dance, so short-lived JWTs don't fit this transport.
//
// Machine identity: machines are rows in team_members (kind='machine', random uuid, no auth user) so
// activity_log/rate_limits/usage_events attribution keeps working unchanged. See migration 0026 +
// thread 0027 "Machine identity model" for the full reasoning. Fails CLOSED throughout: any auth,
// scope, or transport ambiguity returns a rejection before touching Gemini or writing anything.
//
// 🔴 HARD GATE (thread 0027): the service-role key must be ROTATED before the first real machine
// token is issued — a copy of it traveled to a remote machine under the killed REMOTE-SETUP runbook.
// Rotation is a deploy-gate step in this unit's acceptance criteria, not optional and not separate.
//
// SCOPE DECISION (thread 0029 item 4): v1 is CLI/server-side MCP clients ONLY. Browser-hosted clients
// (e.g. a claude.ai web connector) are explicitly OUT OF SCOPE — they bring OAuth/dynamic-client-
// registration and a real CORS surface that belongs to a future unit (already listed in thread 0027's
// Non-goals). Consequences, deliberate, not gaps: no CORS headers, no preflight path — OPTIONS (and
// every other non-POST method) → 405 with `Allow: POST, GET`; a browser `Origin` header (including
// `https://claude.ai`) is rejected exactly like any other foreign origin, pre-auth, per originAllowed().
//
// Reuses the SAME core logic as the local stdio MCP server — not a reimplementation:
//   - recall:     mcp/lib/recall-core.mjs  (embed + recall_memory RPC)
//   - fetch:      mcp/lib/fetch-core.mjs   (get_memory_entry RPC + egress secret-redaction, now with
//                 max_chars — shared by both surfaces per thread 0027 build instruction #1)
//   - log_update: mcp/lib/log-core.mjs     (log_activity RPC + secret-scan)
// get_secret and remember/update are NOT exposed here — structurally absent, not scope-gated (vault
// reach stays local-single-operator forever; durable-memory writes deferred to a future unit).

import { createClient } from '@supabase/supabase-js'
import { checkRateLimit } from '../_lib/rate-limit'
import { logUsage } from '../_lib/usage'
import { makeEmbedQuery, runRecall, MAX_K, MAX_QUERY_LEN, DEFAULT_K } from '../../mcp/lib/recall-core.mjs'
import { runFetch, MAX_NAME_LEN, MAX_CHARS_CAP } from '../../mcp/lib/fetch-core.mjs'
import { runLogUpdate, MAX_ACTION_LEN } from '../../mcp/lib/log-core.mjs'
import { runBrief } from '../_lib/brief'

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'mnemosyne', version: '1.0.0' }

// Pre-parse caps (Aegis binding gate note): reject oversized auth material / bodies before any
// expensive work. A bearer token is `mnk_` + 43 base64url chars (32 raw bytes) ≈ 47 chars; 512 is
// generous headroom without inviting abuse. 64KB comfortably covers any real tool call's arguments.
const MAX_AUTHZ_HEADER_LEN = 600
const MAX_BODY_BYTES = 65536

// Per-tool rate buckets (thread 0027 remote tool surface table). window is shared (60s) for a
// uniform Retry-After; limits differ per tool's real cost.
const RATE_LIMITS: Record<string, { limit: number; windowSeconds: number }> = {
  recall: { limit: 30, windowSeconds: 60 },
  fetch: { limit: 20, windowSeconds: 60 },
  log_update: { limit: 30, windowSeconds: 60 },
  brief: { limit: 10, windowSeconds: 60 },
}

const MACHINE_ACTION_RE = /^(agent\.|work\.)/

type ToolDef = { name: string; scope: string; description: string; inputSchema: any }

const TOOLS: ToolDef[] = [
  {
    name: 'recall',
    scope: 'recall',
    description: 'Semantic recall over the 4ward shared brain (memory entries + chunks). Returns the most relevant memories with name, title, similarity, source path, and last-updated freshness. Read-only.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: `Natural-language query (max ${MAX_QUERY_LEN} chars).` },
        k: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results 1-20 (default 8; lower cap than the local tool — P5-AGENT-DIET).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch',
    scope: 'fetch',
    description: 'Read the full stored content of one memory entry by its name (slug). Use after recall to read what an entry actually says. Read-only. Response is capped by max_chars (default 8000) — redaction always runs before truncation.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', maxLength: MAX_NAME_LEN, description: 'The entry slug (e.g. from a recall result).' },
        max_chars: { type: 'integer', minimum: 1, maximum: MAX_CHARS_CAP, description: `Cap on returned text length (default 8000, max ${MAX_CHARS_CAP}).` },
      },
      required: ['name'],
    },
  },
  {
    name: 'log_update',
    scope: 'log_update',
    description: 'Append a who-did-what entry to the 4ward activity log. action MUST be prefixed "agent." or "work." for machine actors (e.g. "agent.note"). detail.project, if given and resolvable, links the entry to a project.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', maxLength: MAX_ACTION_LEN, description: 'Namespaced action; machine actors are restricted to "agent.*" or "work.*".' },
        entity_type: { type: 'string', description: 'Optional subject type.' },
        entity_id: { type: 'string', description: 'Optional subject uuid.' },
        detail: { type: 'object', description: 'Optional flat JSON object (≤4KB). A "project" string key is resolved to a project link when possible.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'brief',
    scope: 'brief',
    description: 'One-call project orientation bootstrap: resume memory, recent activity, linked docs, extracted open items — replaces the recall→fetch→activity fan-out. Hard-capped ~16,000 chars with honest truncation flags.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        project: { type: 'string', description: 'Project name (case-insensitive; exact match preferred, falls back to a unique prefix/substring match).' },
      },
      required: ['project'],
    },
  },
]

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const rpcError = (id: unknown, code: number, message: string) =>
  json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, 200)

const rpcResult = (id: unknown, result: unknown) =>
  json({ jsonrpc: '2.0', id, result }, 200)

const toolText = (text: string) => ({ content: [{ type: 'text', text }] })
const toolError = (text: string) => ({ content: [{ type: 'text', text }], isError: true })

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const BODY_TOO_LARGE = Symbol('body_too_large')

// Aegis post-build QC finding: trusting Content-Length alone is bypassable — a chunked/no-Content-
// Length request has no declared length to check, so it would reach `JSON.parse` unbounded. This reads
// the body as a byte stream and enforces the REAL hard limit, canceling and rejecting the moment the
// cap is exceeded — before any text is ever handed to JSON.parse. The Content-Length check upstream
// stays as a cheap fast-path reject for the common case (a declared-oversized body never even starts
// this read), but this is the actual guarantee.
async function readBodyCapped(req: Request, maxBytes: number): Promise<string | typeof BODY_TOO_LARGE> {
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return BODY_TOO_LARGE
    }
    chunks.push(value)
  }
  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(combined)
}

// Allowed Origins for the DNS-rebinding defense. The Pages preview subdomain pattern varies per
// deployment; the production custom origin is fixed and is the one real client-facing surface.
function originAllowed(origin: string | null): boolean {
  if (!origin) return true // absent Origin (CLI/agent clients) — allowed per spec guidance
  if (origin === 'https://project-mnemosyne.pages.dev') return true
  if (/^https:\/\/[a-z0-9-]+\.project-mnemosyne\.pages\.dev$/.test(origin)) return true // CF preview deploys
  return false
}

export const onRequest = async (context: any): Promise<Response> => {
  const req: Request = context.request
  const method = req.method

  // ---- 1. Origin validation — DNS-rebinding defense, spec-REQUIRED, BEFORE any token processing ----
  if (!originAllowed(req.headers.get('origin'))) return json({ error: 'origin not allowed' }, 403)

  // ---- 2. Method routing. Stateless server offers no server-initiated SSE stream, so GET (and
  //    everything except POST) is 405 with Allow naming the two methods the spec defines for this
  //    endpoint shape. ----
  if (method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST, GET' })

  // ---- 3. Accept header — client MUST offer application/json or text/event-stream; we only ever
  //    respond application/json (never open an SSE stream), but a client offering neither can't
  //    parse our response at all. ----
  const accept = req.headers.get('accept') || ''
  if (!accept.includes('application/json') && !accept.includes('text/event-stream')) {
    return json({ error: 'Accept header must include application/json or text/event-stream' }, 406)
  }

  // ---- 4. MCP-Protocol-Version — absent is fine (assume negotiated/latest per spec backwards-compat
  //    guidance, don't hard-fail non-browser clients); present-and-unsupported is 400. Mcp-Session-Id,
  //    if a client sends one, is silently ignored — this server issues none (stateless mode). ----
  const versionHeader = req.headers.get('mcp-protocol-version')
  if (versionHeader && versionHeader !== PROTOCOL_VERSION) {
    return json({ error: `unsupported MCP-Protocol-Version "${versionHeader}"`, supported: [PROTOCOL_VERSION] }, 400)
  }

  // ---- 5. Cheap caps BEFORE expensive parsing/work (Aegis binding gate note). Oversized/malformed
  //    auth material gets the SAME 401 shape as any other invalid token — no oracle. ----
  const authz = req.headers.get('authorization') || ''
  if (authz.length > MAX_AUTHZ_HEADER_LEN) return unauthorized()
  const contentLength = Number(req.headers.get('content-length') || '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return json({ error: 'request body too large' }, 413)

  const env = context.env || {}
  const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY
  const GEMINI = env.GEMINI_API_KEY
  if (!SUPABASE_URL || !SERVICE || !GEMINI) return json({ error: 'server misconfigured' }, 500)
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

  // ---- 6. Token auth: opaque hash lookup, never a JWT. Malformed / unknown / revoked / expired /
  //    deactivated-member / non-machine-row all produce the IDENTICAL 401 — none of them may be
  //    distinguishable. The RPC already filters on kind='machine' (thread 0029); the check here is a
  //    deliberate belt-and-suspenders duplicate, not trust in the RPC alone — a mis-provisioned token
  //    against a human row must be dead on arrival at BOTH layers. ----
  const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : ''
  if (!token) return unauthorized()
  const hash = await sha256Hex(token)
  const { data: verifyRows, error: verifyErr } = await admin.rpc('verify_machine_token', { p_hash: hash })
  const verified = Array.isArray(verifyRows) ? verifyRows[0] : verifyRows
  if (verifyErr || !verified || !verified.active || verified.kind !== 'machine') return unauthorized()
  const actor = { id: verified.member_id as string, kind: verified.kind as string, scopes: (verified.scopes as string[]) ?? [] }

  // ---- 7. Read + parse body (bounded object, single JSON-RPC message — no batching in this unit).
  //    Real byte-capped streaming read (see readBodyCapped) — the Content-Length check in step 5 is
  //    only a fast-path; this is what actually enforces the cap for chunked/no-Content-Length bodies. ----
  const rawBody = await readBodyCapped(req, MAX_BODY_BYTES)
  if (rawBody === BODY_TOO_LARGE) return json({ error: 'request body too large' }, 413)
  let body: any
  try { body = JSON.parse(rawBody) } catch { return rpcError(null, -32700, 'Parse error: invalid JSON') }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request: body must be a single JSON-RPC object (batching not supported)')
  }
  const { id, method: rpcMethod, params } = body

  // ---- 8. Notifications (no id) — best-effort no-op in a stateless server; 202 Accepted, empty body ----
  if (id === undefined) return new Response(null, { status: 202 })

  // ---- 9. JSON-RPC dispatch ----
  if (rpcMethod === 'initialize') {
    return rpcResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO })
  }

  if (rpcMethod === 'tools/list') {
    const scoped = TOOLS.filter((t) => actor.scopes.includes(t.scope))
    return rpcResult(id, { tools: scoped.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
  }

  if (rpcMethod === 'tools/call') {
    if (typeof params !== 'object' || params === null || typeof params.name !== 'string') {
      return rpcError(id, -32602, 'Invalid params: "name" is required')
    }
    const tool = TOOLS.find((t) => t.name === params.name)
    if (!tool) return rpcError(id, -32601, `Method not found: unknown tool "${params.name}"`)
    if (!actor.scopes.includes(tool.scope)) return json({ error: 'forbidden — token lacks the required scope' }, 403)

    const args = typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}

    // Machine action allowlist (thread 0027 build instruction #4) — cheap validation BEFORE the rate
    // check spends a bucket token (0024 P2-ORDER rule: validate → rate-check → expensive work). A
    // disallowed action is a genuine 403, not a tool-execution error — same access-control tier as
    // the scope check above, and it must write NO row.
    if (tool.name === 'log_update' && (typeof args.action !== 'string' || !MACHINE_ACTION_RE.test(args.action))) {
      return json({ error: 'action not allowed for machine actors — must start with "agent." or "work."' }, 403)
    }

    const bucket = RATE_LIMITS[tool.name]
    const rate = await checkRateLimit(admin, actor.id, `mcp_${tool.name}`, bucket.limit, bucket.windowSeconds)
    if (!rate.ok) return rate.res

    const bytesIn = new TextEncoder().encode(JSON.stringify(args)).length
    let resultBody: any
    let ok = true
    try {
      resultBody = await callTool(tool.name, args, { admin, gemini: GEMINI, actor })
    } catch (e: any) {
      ok = false
      resultBody = toolError(String(e?.message ?? e).slice(0, 500))
    }
    const bytesOut = new TextEncoder().encode(JSON.stringify(resultBody)).length
    // AWAITED, deliberately NOT context.waitUntil (2026-07-02 gate-run finding): on this route the
    // waitUntil-deferred logUsage write never reached Postgres — zero rows ever, while the awaited
    // rate_take RPC on the same client in the same handler writes fine, and waitUntil+logUsage works
    // in the onRequestPost /api/* handlers. Root cause in the Pages runtime not established; awaiting
    // is correct-by-construction here (logUsage swallows all errors, so it cannot fail the request)
    // at the cost of ~100-200ms per machine tool call.
    await logUsage(admin, {
      actorId: actor.id, tool: `mcp/${tool.name}`, source: 'mcp',
      model: tool.name === 'recall' ? 'gemini-embedding-001' : null,
      bytesIn, bytesOut, ok,
    })
    return rpcResult(id, resultBody)
  }

  return rpcError(id, -32601, `Method not found: "${rpcMethod}"`)
}

function unauthorized(): Response {
  return json({ error: 'unauthorized' }, 401)
}

// Dispatch to the actual tool logic. Throwing here becomes a JSON-RPC tool-call error (isError:true) —
// callers get a normal 200 response with the failure described in content, not a transport error.
async function callTool(name: string, args: any, ctx: { admin: any; gemini: string; actor: { id: string; kind: string; scopes: string[] } }): Promise<any> {
  const { admin, gemini, actor } = ctx
  const rpc = (fn: string, rpcArgs: any) => admin.rpc(fn, rpcArgs)

  if (name === 'recall') {
    // Hosted cap is tighter than the local tool's (20 vs 50, P5-AGENT-DIET) — recall-core.mjs's own
    // validateArgs only enforces the LOCAL MAX_K=50, so the hosted-specific ceiling must be applied
    // here, before delegating. Clamps rather than rejects (thread 0027 acceptance criterion 4).
    const HOSTED_MAX_K = 20
    const clampedArgs = typeof args?.k === 'number' && args.k > HOSTED_MAX_K ? { ...args, k: HOSTED_MAX_K } : args
    const embedQuery = makeEmbedQuery({ apiKey: gemini })
    const text = await runRecall(clampedArgs, { embedQuery, rpc })
    return toolText(text)
  }

  if (name === 'fetch') {
    // Hosted default is 8,000 chars when unspecified (thread 0027 "brief" table); the local tool's
    // default (omitted = full body, no cap) is NOT appropriate for the hosted surface.
    const HOSTED_DEFAULT_MAX_CHARS = 8000
    const cappedArgs = args?.max_chars === undefined ? { ...args, max_chars: HOSTED_DEFAULT_MAX_CHARS } : args
    const text = await runFetch(cappedArgs, { rpc })
    return toolText(text)
  }

  if (name === 'log_update') {
    // Machine action allowlist is enforced in the tools/call handler (403, before this is ever
    // reached) — not repeated here.
    // Forward-fix rider: resolve detail.project -> projects.id and set entity_id when resolvable.
    // Best-effort — a miss (or an empty projects table) must not fail the write; it just means the
    // entry keeps the free-text detail.project field only, exactly like every human-written row today.
    let entity_type = args.entity_type, entity_id = args.entity_id
    const projectName = typeof args?.detail?.project === 'string' ? args.detail.project : null
    if (projectName && entity_id === undefined) {
      try {
        const { data: projects } = await admin.from('projects').select('id, name')
        const match = (projects ?? []).find((p: any) => p.name.toLowerCase() === projectName.toLowerCase())
        if (match) { entity_type = entity_type ?? 'project'; entity_id = match.id }
      } catch { /* best-effort linking only; never blocks the write */ }
    }
    const text = await runLogUpdate({ ...args, entity_type, entity_id }, { rpc, actorId: actor.id })
    return toolText(text)
  }

  if (name === 'brief') {
    const result = await runBrief(args, { admin })
    return toolText(JSON.stringify(result))
  }

  throw new Error(`unhandled tool "${name}"`)
}
