// Mnemosyne — Sales Factory C5.1: create/update a client (CF Pages Function).
// JWT → active member → upsert_client RPC (actor = authenticated uid). Writes are server-mediated: the
// clients table is read-only for members (migration 0015), so this RPC is the only write path. Fails CLOSED.

import { requireMember, parseStrict, isUuid, json } from '../_lib/member-auth'

export const onRequestPost = async (context: any): Promise<Response> => {
  const parsed = await parseStrict(context, ['id', 'name', 'notes'])
  if (!parsed.ok) return parsed.res
  const b = parsed.body
  if (b.id !== undefined && b.id !== null && !isUuid(b.id)) return json({ error: '"id" must be a uuid' }, 400)
  if (typeof b.name !== 'string' || !b.name.trim()) return json({ error: '"name" must be a non-empty string' }, 400)
  if (b.name.length > 200) return json({ error: '"name" exceeds 200 chars' }, 400)
  if (b.notes !== undefined && b.notes !== null && typeof b.notes !== 'string') return json({ error: '"notes" must be a string' }, 400)
  if (typeof b.notes === 'string' && b.notes.length > 4000) return json({ error: '"notes" exceeds 4000 chars' }, 400)

  const auth = await requireMember(context)
  if (!auth.ok) return auth.res

  const payload: any = { name: b.name.trim() }
  if (b.id) payload.id = b.id
  if (b.notes !== undefined) payload.notes = b.notes
  const { data: id, error } = await auth.admin.rpc('upsert_client', { p_payload: payload, p_actor: auth.uid, p_audit: { op: b.id ? 'update' : 'create' } })
  if (error) {
    const msg = error.message || ''
    if (/upsert_client:|not found|required|too long|must be/i.test(msg)) return json({ error: msg }, 400)
    return json({ error: 'write failed' }, 502)
  }
  return json({ id }, b.id ? 200 : 201)
}
