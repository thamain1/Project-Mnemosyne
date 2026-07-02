// Mnemosyne — client_360 endpoint (thread 0032 P2-BRIDGE). CF Pages Function.
//
// The grounding call for P2-LOOP and the future "Sales" column of the Agentic-OS view: everything
// known about one client in one call — client row + contacts + deals + linked memories (metadata
// only, never bodies) + linked documents (metadata only) + last 20 activity rows.
//
// client_360 itself is service-role-only (revoked from public/anon/authenticated, per the house
// pattern — same posture as verify_machine_token/log_usage). This endpoint is the ONLY human-facing
// exposure: requireMember() (JWT -> active team member, fail closed) BEFORE calling the RPC with the
// service client. Anon/non-member never reach the RPC.

import { requireMember, parseStrict, isUuid, json } from '../_lib/member-auth'

export const onRequestPost = async (context: any): Promise<Response> => {
  const auth = await requireMember(context)
  if (!auth.ok) return auth.res

  const parsed = await parseStrict(context, ['client_id'])
  if (!parsed.ok) return parsed.res
  const { client_id } = parsed.body
  if (!isUuid(client_id)) return json({ error: '"client_id" must be a uuid' }, 400)

  const { data, error } = await auth.admin.rpc('client_360', { p_client_id: client_id })
  if (error) {
    const msg = error.message || ''
    if (/not found/i.test(msg)) return json({ error: msg }, 404)
    if (/client_360:/i.test(msg)) return json({ error: msg }, 400)
    return json({ error: 'lookup failed' }, 502)
  }
  return json(data)
}
