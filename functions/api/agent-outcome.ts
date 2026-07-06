// Mnemosyne — Agent Outcome API (docs/WORK-ORDER-AGENT-API.md, migration 0031). CF Pages Function.
//
// The write side of the IntelliService-ISB wiring. Mnemosyne receives only QUALITATIVE signal here,
// never raw session/operational data (that stays in ISB's own agent_session_logs — the "distill, don't
// accumulate" rule, Jesse+Atlas 2026-07-04). Every call appends exactly one activity_log row (the
// durable per-client audit trail); a SUBSET of event types additionally get a tagged, embedded
// memory_entries row so the fact becomes recallable context on the next /api/agent-context call for
// that customer/tech — the learning loop. Both writes happen atomically inside record_agent_outcome
// (migration 0031) so a memory-insert failure can never leave an orphaned activity row or vice versa.
//
// No consolidation/rollup job in this unit (flagged as the designed v2 — WO §4): one memory row per
// qualifying event. Auth: opaque agent_clients bearer (functions/_lib/agent-api.ts), same narrower
// trust tier as /api/agent-context.

import { isUuid } from '../_lib/member-auth'
import { requireAgentClient, SYSTEM_ACTOR_ID } from '../_lib/agent-api'
import { checkRateLimit } from '../_lib/rate-limit'
import { logUsage } from '../_lib/usage'
import { scanSecret, makeEmbedDoc } from '../../mcp/lib/remember-core.mjs'

const RATE_LIMIT = 120      // per WO §4
const RATE_WINDOW_S = 60
const MAX_SUMMARY_LEN = 500
const MAX_NAME_LEN = 200    // customer_name / tech_name

const EVENT_TYPES = new Set([
  'dispatch_rejected', 'dispatch_override', 'contract_won', 'contract_lost', 'contract_dismissed', 'note',
])
// Event types that carry reusable qualitative content and get a tagged memory row (WO §4). The other
// two (contract_won, contract_dismissed) are activity-log-only in v1 — no "has notable content" signal
// exists in the fixed contract to distinguish a notable contract_won from a routine one.
const MEMORY_EVENT_TYPES = new Set(['dispatch_rejected', 'dispatch_override', 'contract_lost', 'note'])

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function slugName(): string {
  return `agent-${crypto.randomUUID()}`
}

export const onRequestPost = async (context: any): Promise<Response> => {
  const env = context.env || {}
  const GEMINI = env.GEMINI_API_KEY

  // ---- parse + strict args (additionalProperties:false) ----
  let payload: any
  try { payload = await context.request.json() } catch { return json({ error: 'invalid JSON body' }, 400) }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return json({ error: 'body must be an object' }, 400)
  const ALLOWED = ['event_type', 'summary', 'customer_id', 'customer_name', 'tech_id', 'tech_name', 'ref']
  for (const key of Object.keys(payload)) if (!ALLOWED.includes(key)) return json({ error: `unexpected field "${key}"` }, 400)

  if (typeof payload.event_type !== 'string' || !EVENT_TYPES.has(payload.event_type)) {
    return json({ error: `"event_type" must be one of ${[...EVENT_TYPES].join(', ')}` }, 400)
  }
  const eventType: string = payload.event_type

  if (typeof payload.summary !== 'string' || !payload.summary.trim()) return json({ error: '"summary" must be a non-empty string' }, 400)
  const summary = payload.summary.trim()
  if (summary.length > MAX_SUMMARY_LEN) return json({ error: `"summary" exceeds ${MAX_SUMMARY_LEN} chars` }, 400)
  const secretReason = scanSecret(summary)
  if (secretReason) return json({ error: `"summary" refused: ${secretReason} — secrets must never be stored here` }, 400)

  const strOpt = (v: unknown, label: string, maxLen: number): { ok: true; val: string | null } | { ok: false; res: Response } => {
    if (v === undefined || v === null) return { ok: true, val: null }
    if (typeof v !== 'string' || !v.trim()) return { ok: false, res: json({ error: `"${label}" must be a non-empty string` }, 400) }
    if (v.length > maxLen) return { ok: false, res: json({ error: `"${label}" exceeds ${maxLen} chars` }, 400) }
    return { ok: true, val: v.trim() }
  }

  if (payload.customer_id !== undefined && (typeof payload.customer_id !== 'string' || !isUuid(payload.customer_id))) {
    return json({ error: '"customer_id" must be a uuid string' }, 400)
  }
  const customerId: string | null = payload.customer_id ?? null
  if (payload.tech_id !== undefined && (typeof payload.tech_id !== 'string' || !isUuid(payload.tech_id))) {
    return json({ error: '"tech_id" must be a uuid string' }, 400)
  }
  const techId: string | null = payload.tech_id ?? null

  const customerNameR = strOpt(payload.customer_name, 'customer_name', MAX_NAME_LEN); if (!customerNameR.ok) return customerNameR.res
  const techNameR = strOpt(payload.tech_name, 'tech_name', MAX_NAME_LEN); if (!techNameR.ok) return techNameR.res
  const refR = strOpt(payload.ref, 'ref', 200); if (!refR.ok) return refR.res
  const customerName = customerNameR.val, techName = techNameR.val, ref = refR.val

  // ---- authz: opaque agent_clients bearer -> client_slug (fail closed) ----
  const auth = await requireAgentClient(context)
  if (!auth.ok) return auth.res
  const { clientSlug, admin } = auth

  const rate = await checkRateLimit(admin, SYSTEM_ACTOR_ID, `agent_outcome:${clientSlug}`, RATE_LIMIT, RATE_WINDOW_S)
  if (!rate.ok) return rate.res

  // ---- build the always-written activity_log detail (bounded, flat — log_activity re-validates) ----
  const detail = {
    client_slug: clientSlug, event_type: eventType, summary,
    customer_id: customerId, customer_name: customerName,
    tech_id: techId, tech_name: techName, ref,
  }

  // ---- optionally build the tagged memory payload (embeds — the one place this endpoint spends real cost) ----
  let memory: any = null
  if (MEMORY_EVENT_TYPES.has(eventType)) {
    if (!GEMINI) return json({ error: 'server misconfigured' }, 500)
    const who = customerName || techName || customerId || techId || 'general'
    const title = `${eventType}: ${who}`.slice(0, 300)
    const body = `[${eventType}] ${summary}`
    const titleSecret = scanSecret(title)
    if (titleSecret) return json({ error: `derived title refused: ${titleSecret}` }, 400)

    const tags = [
      `client:${clientSlug}`,
      customerId ? `isb-customer:${customerId}` : null,
      techId ? `isb-tech:${techId}` : null,
    ].filter((t): t is string => Boolean(t))

    let embedding: string
    try {
      const embedDoc = makeEmbedDoc({ apiKey: GEMINI })
      embedding = await embedDoc(`${title}\n\n${body}`)
    } catch {
      return json({ error: 'embedding failed' }, 502)
    }

    memory = { name: slugName(), kind: 'reference', title, body, tags, embedding }
    // record_agent_outcome validates name/kind/title/body/tags shape server-side too (defense in depth).
  }

  // ---- atomic write: activity_log always, memory_entries conditionally (migration 0031) ----
  const { data, error } = await admin.rpc('record_agent_outcome', {
    p_actor: SYSTEM_ACTOR_ID, p_client_slug: clientSlug, p_action: `agent.${eventType}`,
    p_detail: detail, p_memory: memory,
  })
  if (error) {
    const msg = error.message || ''
    if (/must|too long|too many|bad |unexpected key/i.test(msg)) return json({ error: msg }, 400)
    return json({ error: 'write failed' }, 502)
  }

  context.waitUntil(logUsage(admin, {
    actorId: SYSTEM_ACTOR_ID, tool: 'api/agent-outcome', source: 'endpoint',
    model: memory ? 'gemini-embedding-001' : null,
    bytesIn: JSON.stringify(payload).length, bytesOut: JSON.stringify(data ?? {}).length,
  }))

  return json({ ok: true })
}
// (Only onRequestPost is exported, so CF Pages auto-returns 405 for any non-POST method.)
