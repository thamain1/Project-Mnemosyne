// Mnemosyne — Sales Factory C5.1: attach/detach a document to a deal (CF Pages Function).
// JWT → active member → link_document_deal RPC (actor = authenticated uid). documents is write-locked
// (migration 0014), so deal_id is set only via this service-role RPC. deal_id null → detach. Fails CLOSED.

import { requireMember, parseStrict, isUuid, json } from '../_lib/member-auth'

export const onRequestPost = async (context: any): Promise<Response> => {
  const parsed = await parseStrict(context, ['document_id', 'deal_id'])
  if (!parsed.ok) return parsed.res
  const b = parsed.body
  if (!isUuid(b.document_id)) return json({ error: '"document_id" must be a uuid' }, 400)
  if (b.deal_id !== null && !isUuid(b.deal_id)) return json({ error: '"deal_id" must be a uuid or null' }, 400)

  const auth = await requireMember(context)
  if (!auth.ok) return auth.res

  const { error } = await auth.admin.rpc('link_document_deal', { p_document_id: b.document_id, p_deal_id: b.deal_id, p_actor: auth.uid })
  if (error) {
    const msg = error.message || ''
    if (/link_document_deal:|not found/i.test(msg)) return json({ error: msg }, 400)
    return json({ error: 'link failed' }, 502)
  }
  return json({ ok: true }, 200)
}
