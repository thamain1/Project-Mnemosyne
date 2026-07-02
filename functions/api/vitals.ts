// Mnemosyne — vitals endpoint (thread 0032 UI rider 2). CF Pages Function.
//
// The ONLY count this endpoint exists for: active (non-revoked, non-expired) machine_tokens.
// machine_tokens is deliberately service-role-only (migration 0026: RLS on, `revoke all from anon,
// authenticated`, no member SELECT policy at all — the token hash itself is sensitive, it enables
// offline hash comparison). This endpoint does NOT loosen that: requireMember() gates it, and the
// response is a bare count, never token rows, hashes, or labels. The other vitals (7-day calls/
// tokens/bytes) are read directly from the dashboard via usage_events, which IS member-readable
// (thread 0025's grant fix) — no endpoint needed for those.

import { requireMember, json } from '../_lib/member-auth'

export const onRequestGet = async (context: any): Promise<Response> => {
  const auth = await requireMember(context)
  if (!auth.ok) return auth.res

  // fetch only expires_at (never hash/label/member_id — nothing sensitive) for non-revoked tokens,
  // then filter expiry in code. The active-machine set is expected to be tiny (a handful of
  // integrations), so this is simpler and safer than encoding an OR-filter timestamp comparison
  // into a PostgREST filter string.
  const { data, error } = await auth.admin.from('machine_tokens').select('expires_at').is('revoked_at', null)
  if (error) return json({ error: 'lookup failed' }, 502)

  const now = Date.now()
  const activeMachines = (data ?? []).filter((t: any) => !t.expires_at || new Date(t.expires_at).getTime() > now).length
  return json({ activeMachines })
}
// (Only onRequestGet is exported, so CF Pages auto-returns 405 for any non-GET method.)
