// Mnemosyne — Agent Context API (docs/WORK-ORDER-AGENT-API.md, migration 0031). CF Pages Function.
//
// The recall side of the IntelliService-ISB wiring. ISB's dispatch/contract agents send their own
// customer/tech UUIDs; this endpoint resolves them against tag-filtered memory_entries (§2: every
// agent-sourced memory carries client:<slug> + isb-customer:<uuid> / isb-tech:<uuid> tags) and returns
// a compact plain-text digest. Deliberately NO Gemini embed call — the structured tags make semantic
// search unnecessary here and keep this endpoint fast + free (the design divergence from /api/recall,
// which DOES embed). ISB truncates at 2000 chars and times out at 5s; this responds well inside both.
//
// Auth: opaque agent_clients bearer token (see functions/_lib/agent-api.ts), NOT a Supabase JWT and
// NOT a hosted-MCP machine token — a narrower trust tier that can reach exactly this endpoint and
// /api/agent-outcome. Fails CLOSED: cross-client leakage (client A's token surfacing client B's
// memories) is the one unforgivable bug here — the tags @> filter on the caller's OWN resolved
// client_slug is non-negotiable and never derived from the request body.

import { isUuid } from '../_lib/member-auth'
import { requireAgentClient, SYSTEM_ACTOR_ID } from '../_lib/agent-api'
import { checkRateLimit } from '../_lib/rate-limit'
import { logUsage } from '../_lib/usage'

const RATE_LIMIT = 60       // per WO §3 — dispatch batches hit this ~once per ticket
const RATE_WINDOW_S = 60
const MAX_TECH_IDS = 20
const MAX_CONTEXT_CHARS = 2000
const MAX_ROWS = 20         // memory rows considered before composing the digest

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export const onRequestPost = async (context: any): Promise<Response> => {
  // ---- parse + strict args (additionalProperties:false) ----
  let payload: any
  try { payload = await context.request.json() } catch { return json({ error: 'invalid JSON body' }, 400) }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return json({ error: 'body must be an object' }, 400)
  for (const key of Object.keys(payload)) if (key !== 'customer_id' && key !== 'tech_ids') return json({ error: `unexpected field "${key}"` }, 400)

  if (typeof payload.customer_id !== 'string' || !isUuid(payload.customer_id)) {
    return json({ error: '"customer_id" must be a uuid string' }, 400)
  }
  const customerId: string = payload.customer_id

  if (!Array.isArray(payload.tech_ids)) return json({ error: '"tech_ids" must be an array' }, 400)
  if (payload.tech_ids.length > MAX_TECH_IDS) return json({ error: `"tech_ids" exceeds ${MAX_TECH_IDS} entries` }, 400)
  for (const t of payload.tech_ids) if (typeof t !== 'string' || !isUuid(t)) return json({ error: '"tech_ids" must all be uuid strings' }, 400)
  const techIds: string[] = payload.tech_ids

  // ---- authz: opaque agent_clients bearer -> client_slug (fail closed) ----
  const auth = await requireAgentClient(context)
  if (!auth.ok) return auth.res
  const { clientSlug, admin } = auth

  const rate = await checkRateLimit(admin, SYSTEM_ACTOR_ID, `agent_context:${clientSlug}`, RATE_LIMIT, RATE_WINDOW_S)
  if (!rate.ok) return rate.res

  // ---- lookup: client-scoped AND (this customer OR any of these techs) ----
  const customerTag = `isb-customer:${customerId}`
  const wantedTags = [customerTag, ...techIds.map((t) => `isb-tech:${t}`)]
  const { data: rows, error } = await admin
    .from('memory_entries')
    .select('body, tags, updated_at')
    .contains('tags', [`client:${clientSlug}`])
    .overlaps('tags', wantedTags)
    .order('updated_at', { ascending: false })
    .limit(MAX_ROWS)
  if (error) return json({ error: 'lookup failed' }, 502)

  const found = rows ?? []
  // customer-scoped facts first, then per-tech facts — both already newest-first from the query order.
  const customerFacts = found.filter((r: any) => Array.isArray(r.tags) && r.tags.includes(customerTag))
  const techFacts = found.filter((r: any) => !customerFacts.includes(r))
  const lines = [...customerFacts, ...techFacts].map((r: any) => `- ${String(r.body).trim()}`)

  let composed = lines.join('\n')
  if (composed.length > MAX_CONTEXT_CHARS) composed = composed.slice(0, MAX_CONTEXT_CHARS)
  const contextText = composed.length ? composed : null

  // safe metadata only — never memory content
  context.waitUntil(logUsage(admin, {
    actorId: SYSTEM_ACTOR_ID, tool: 'api/agent-context', source: 'endpoint',
    bytesIn: JSON.stringify(payload).length, bytesOut: contextText?.length ?? 0,
  }))

  return json({ context: contextText })
}
// (Only onRequestPost is exported, so CF Pages auto-returns 405 for any non-POST method.)
