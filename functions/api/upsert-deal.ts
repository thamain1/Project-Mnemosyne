// Mnemosyne — Sales Factory C5.1: create/update a deal (CF Pages Function).
// JWT → active member → upsert_deal RPC (actor = authenticated uid). deals is read-only for members
// (migration 0015); this RPC is the only write path. The RPC validates stage/client_id/owner_id. Fails CLOSED.

import { requireMember, parseStrict, isUuid, json } from '../_lib/member-auth'

const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost']

export const onRequestPost = async (context: any): Promise<Response> => {
  const parsed = await parseStrict(context, ['id', 'client_id', 'title', 'stage', 'amount', 'currency', 'owner_id', 'notes'])
  if (!parsed.ok) return parsed.res
  const b = parsed.body
  if (b.id !== undefined && b.id !== null && !isUuid(b.id)) return json({ error: '"id" must be a uuid' }, 400)
  if (b.client_id !== undefined && b.client_id !== null && !isUuid(b.client_id)) return json({ error: '"client_id" must be a uuid' }, 400)
  if (b.owner_id !== undefined && b.owner_id !== null && !isUuid(b.owner_id)) return json({ error: '"owner_id" must be a uuid' }, 400)
  if (typeof b.title !== 'string' || !b.title.trim()) return json({ error: '"title" must be a non-empty string' }, 400)
  if (b.title.length > 200) return json({ error: '"title" exceeds 200 chars' }, 400)
  if (typeof b.stage !== 'string' || !STAGES.includes(b.stage)) return json({ error: `"stage" must be one of ${STAGES.join(', ')}` }, 400)
  if (b.amount !== undefined && b.amount !== null && (typeof b.amount !== 'number' || !Number.isFinite(b.amount) || b.amount < 0)) return json({ error: '"amount" must be a non-negative number' }, 400)
  if (b.currency !== undefined && b.currency !== null && (typeof b.currency !== 'string' || b.currency.length > 10)) return json({ error: '"currency" must be a string (<=10 chars)' }, 400)
  if (b.notes !== undefined && b.notes !== null && typeof b.notes !== 'string') return json({ error: '"notes" must be a string' }, 400)
  if (typeof b.notes === 'string' && b.notes.length > 4000) return json({ error: '"notes" exceeds 4000 chars' }, 400)

  const auth = await requireMember(context)
  if (!auth.ok) return auth.res

  const payload: any = { title: b.title.trim(), stage: b.stage }
  if (b.id) payload.id = b.id
  if (b.client_id !== undefined) payload.client_id = b.client_id
  if (b.owner_id !== undefined) payload.owner_id = b.owner_id
  if (b.amount !== undefined) payload.amount = b.amount
  if (b.currency !== undefined) payload.currency = b.currency
  if (b.notes !== undefined) payload.notes = b.notes

  const { data: id, error } = await auth.admin.rpc('upsert_deal', { p_payload: payload, p_actor: auth.uid, p_audit: { op: b.id ? 'update' : 'create', stage: b.stage } })
  if (error) {
    const msg = error.message || ''
    if (/upsert_deal:|not found|required|bad |out of range|too long|must be/i.test(msg)) return json({ error: msg }, 400)
    return json({ error: 'write failed' }, 502)
  }
  return json({ id }, b.id ? 200 : 201)
}
