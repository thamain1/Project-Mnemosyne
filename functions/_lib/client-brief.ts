// Mnemosyne — hosted MCP `client_brief` + `client_360` tool support (thread 0033 P2-LOOP Part C).
//
// client_brief is a narrow, machine-only WRITE path: it never guesses (unresolvable/ambiguous client
// or deal -> a thrown, descriptive error, never a silent pick), never auto-creates a client, and does
// exactly ONE write (upsert_client_brief, migration 0030) per call. client_360 is the read-side
// grounding call — a thin wrapper over the existing service-role client_360 RPC (migration 0027) with
// a structural response cap so an oversized fixture never returns unparseable truncated JSON.
//
// RESOLUTION STYLE (deliberate asymmetry, same underlying algorithm): resolveClient/resolveDealForClient
// are the SAME resolution rules for both tools ("same resolution rules as C1" per the design). But
// client_brief (a write) THROWS on an unresolved/ambiguous match — matching every write RPC in this
// codebase (upsert_client/upsert_deal/upsert_contact/ingest_memory_entry all raise on a bad FK) and
// fetch-core's "unknown heading" precedent (throws with the candidate list baked into the message).
// client_360 (a read, like `brief`) returns a soft {error, candidates} object instead — matching
// brief.ts's convention for read-only orientation tools, where an unresolved name is an expected
// outcome to report, not a failure to throw. The RESOLUTION LOGIC itself is identical either way; only
// how each tool's caller reports a miss differs, and that's justified by write-vs-read, not by any
// difference in how resolution works.

import { isUuid, scanSecret } from '../../mcp/lib/remember-core.mjs'

const MAX_CLIENT_LEN = 200
const MAX_DEAL_LEN = 200
const MAX_TITLE_LEN = 200
const MAX_BODY_LEN = 24000
const CLIENT_360_BUDGET = 16000
const DROP_ORDER: Array<'activity' | 'documents' | 'memories'> = ['activity', 'documents', 'memories']

// ── arg validation ──────────────────────────────────────────────────────────────────────────────────

export function validateClientBriefArgs(args: any): { client: string; title: string; body: string; deal?: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('client_brief: arguments must be an object')
  for (const k of Object.keys(args)) if (!['client', 'title', 'body', 'deal'].includes(k)) throw new Error(`client_brief: unexpected argument "${k}"`)
  if (typeof args.client !== 'string' || !args.client.trim()) throw new Error('client_brief: "client" must be a non-empty string')
  if (args.client.length > MAX_CLIENT_LEN) throw new Error(`client_brief: "client" exceeds ${MAX_CLIENT_LEN} chars`)
  if (typeof args.title !== 'string' || !args.title.trim()) throw new Error('client_brief: "title" must be a non-empty string')
  if (args.title.length > MAX_TITLE_LEN) throw new Error(`client_brief: "title" exceeds ${MAX_TITLE_LEN} chars`)
  if (typeof args.body !== 'string' || !args.body.trim()) throw new Error('client_brief: "body" must be a non-empty string')
  if (args.body.length > MAX_BODY_LEN) throw new Error(`client_brief: "body" exceeds ${MAX_BODY_LEN} chars`)
  let deal: string | undefined
  if (args.deal !== undefined) {
    if (typeof args.deal !== 'string' || !args.deal.trim()) throw new Error('client_brief: "deal" must be a non-empty string')
    if (args.deal.length > MAX_DEAL_LEN) throw new Error(`client_brief: "deal" exceeds ${MAX_DEAL_LEN} chars`)
    deal = args.deal.trim()
  }
  return { client: args.client.trim(), title: args.title.trim(), body: args.body, deal }
}

export function validateClient360Args(args: any): { client: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('client_360: arguments must be an object')
  for (const k of Object.keys(args)) if (k !== 'client') throw new Error(`client_360: unexpected argument "${k}"`)
  if (typeof args.client !== 'string' || !args.client.trim()) throw new Error('client_360: "client" must be a non-empty string')
  if (args.client.length > MAX_CLIENT_LEN) throw new Error(`client_360: "client" exceeds ${MAX_CLIENT_LEN} chars`)
  return { client: args.client.trim() }
}

// ── resolution (uuid-or-name/title, never guess) ────────────────────────────────────────────────────

type ResolveClientResult =
  | { ok: true; id: string; name: string }
  | { ok: false; reason: 'not_found' | 'ambiguous'; candidates: string[] }

export async function resolveClient(admin: any, input: string): Promise<ResolveClientResult> {
  if (isUuid(input)) {
    const { data, error } = await admin.from('clients').select('id, name').eq('id', input).maybeSingle()
    if (error) throw new Error(`client lookup failed: ${error.message}`)
    if (!data) return { ok: false, reason: 'not_found', candidates: [] }
    return { ok: true, id: data.id, name: data.name }
  }
  const { data: rows, error } = await admin.from('clients').select('id, name')
  if (error) throw new Error(`client lookup failed: ${error.message}`)
  const clients: { id: string; name: string }[] = rows ?? []
  const needle = input.toLowerCase()
  const exact = clients.filter((c) => c.name.toLowerCase() === needle)
  if (exact.length === 1) return { ok: true, id: exact[0].id, name: exact[0].name }
  if (exact.length > 1) return { ok: false, reason: 'ambiguous', candidates: exact.map((c) => c.name) }
  const substr = clients.filter((c) => c.name.toLowerCase().includes(needle))
  if (substr.length === 1) return { ok: true, id: substr[0].id, name: substr[0].name }
  if (substr.length > 1) return { ok: false, reason: 'ambiguous', candidates: substr.map((c) => c.name) }
  return { ok: false, reason: 'not_found', candidates: [] }
}

type ResolveDealResult =
  | { ok: true; id: string; title: string }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'not_in_client'; candidates: string[] }

// deal resolution is SCOPED to the already-resolved client — a uuid for a deal belonging to a
// DIFFERENT client is a "not_in_client" miss, never silently accepted (thread 0033 acceptance
// criterion 3: "foreign deal uuid -> error").
export async function resolveDealForClient(admin: any, input: string, clientId: string): Promise<ResolveDealResult> {
  if (isUuid(input)) {
    const { data, error } = await admin.from('deals').select('id, title, client_id').eq('id', input).maybeSingle()
    if (error) throw new Error(`deal lookup failed: ${error.message}`)
    if (!data) return { ok: false, reason: 'not_found', candidates: [] }
    if (data.client_id !== clientId) return { ok: false, reason: 'not_in_client', candidates: [] }
    return { ok: true, id: data.id, title: data.title }
  }
  const { data: rows, error } = await admin.from('deals').select('id, title').eq('client_id', clientId)
  if (error) throw new Error(`deal lookup failed: ${error.message}`)
  const deals: { id: string; title: string }[] = rows ?? []
  const needle = input.toLowerCase()
  const exact = deals.filter((d) => d.title.toLowerCase() === needle)
  if (exact.length === 1) return { ok: true, id: exact[0].id, title: exact[0].title }
  if (exact.length > 1) return { ok: false, reason: 'ambiguous', candidates: exact.map((d) => d.title) }
  const substr = deals.filter((d) => d.title.toLowerCase().includes(needle))
  if (substr.length === 1) return { ok: true, id: substr[0].id, title: substr[0].title }
  if (substr.length > 1) return { ok: false, reason: 'ambiguous', candidates: substr.map((d) => d.title) }
  return { ok: false, reason: 'not_found', candidates: [] }
}

// ── client_brief: prepare (cheap: validate/scan/resolve) + execute (expensive: embed/write) ────────
// Split so the hosted endpoint can run `prepare` BEFORE spending one of only 6/hour rate-limit slots
// (thread 0033 P2-ORDER: a call that was always going to fail on bad args/a planted secret/an
// unresolvable client must not cost the caller part of a scarce budget) and `execute` AFTER — mirrors
// the log_update machine-action-allowlist hoist already in functions/api/mcp.ts for the same reason.

export type PreparedClientBrief = { clientId: string; clientName: string; dealId: string | null; title: string; body: string }

export async function prepareClientBrief(admin: any, args: any): Promise<PreparedClientBrief> {
  const { client, title, body, deal } = validateClientBriefArgs(args)
  const reason = scanSecret(`${title}\n${body}`)
  if (reason) throw new Error(`client_brief refused: ${reason} — secrets must never be stored in the brain (use the vault)`)

  const clientRes = await resolveClient(admin, client)
  if (!clientRes.ok) {
    throw new Error(
      clientRes.reason === 'ambiguous'
        ? `client_brief: ambiguous client "${client}" — candidates: ${clientRes.candidates.join(', ')}`
        : `client_brief: client "${client}" not found — create it first via the CRM tab (no auto-create)`,
    )
  }

  let dealId: string | null = null
  if (deal !== undefined) {
    const dealRes = await resolveDealForClient(admin, deal, clientRes.id)
    if (!dealRes.ok) {
      throw new Error(
        dealRes.reason === 'ambiguous'
          ? `client_brief: ambiguous deal "${deal}" for client "${clientRes.name}" — candidates: ${dealRes.candidates.join(', ')}`
          : `client_brief: deal "${deal}" not found for client "${clientRes.name}" (a uuid must belong to this client; a title must match exactly one of its deals)`,
      )
    }
    dealId = dealRes.id
  }

  return { clientId: clientRes.id, clientName: clientRes.name, dealId, title, body }
}

export async function executeClientBrief(
  prepared: PreparedClientBrief,
  { rpc, embedDoc, actorId }: { rpc: (fn: string, args: any) => Promise<{ data: any; error: any }>; embedDoc: (text: string) => Promise<string>; actorId: string },
): Promise<any> {
  const vecLit = await embedDoc(`${prepared.title}\n\n${prepared.body}`)
  const { data, error } = await rpc('upsert_client_brief', {
    p_actor: actorId,
    p_client_id: prepared.clientId,
    p_deal_id: prepared.dealId,
    p_title: prepared.title,
    p_body: prepared.body,
    p_embedding: vecLit,
    p_embedding_model: 'gemini-embedding-001',
  })
  if (error) throw new Error(`upsert_client_brief error: ${error.message}`)
  return data
}

// ── client_360: read + structural cap ───────────────────────────────────────────────────────────────
// Never raw-JSON-truncated (that breaks parseability) — drop whole items from the lowest-priority arm
// first (activity -> documents -> memories; client/contacts/deals are never dropped), recording how
// many were dropped per arm so a caller always knows exactly what was clipped.
export function capClient360(result: any): any {
  const truncated: Record<string, number> = {}
  if (JSON.stringify(result).length <= CLIENT_360_BUDGET) return { ...result, truncated }

  const out: any = { ...result }
  for (const arm of DROP_ORDER) {
    const original = Array.isArray(out[arm]) ? out[arm] : []
    let arr = original.slice()
    while (arr.length > 0 && JSON.stringify({ ...out, [arm]: arr, truncated }).length > CLIENT_360_BUDGET) {
      arr.pop()
    }
    out[arm] = arr
    const dropped = original.length - arr.length
    if (dropped > 0) truncated[arm] = dropped
    if (JSON.stringify({ ...out, truncated }).length <= CLIENT_360_BUDGET) break
  }
  out.truncated = truncated
  return out
}

export async function runClient360(args: any, { admin, rpc }: { admin: any; rpc: (fn: string, args: any) => Promise<{ data: any; error: any }> }): Promise<any> {
  const { client } = validateClient360Args(args)
  const resolved = await resolveClient(admin, client)
  if (!resolved.ok) return { client, error: resolved.reason, candidates: resolved.candidates }
  const { data, error } = await rpc('client_360', { p_client_id: resolved.id })
  if (error) throw new Error(`client_360 error: ${error.message}`)
  return capClient360(data)
}
