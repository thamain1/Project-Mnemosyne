// Mnemosyne — Phase 2 / Unit C: first authenticated WRITE endpoint (CF Pages Function).
//
// Posts a who-did-what note to the activity feed. This is the foundational dashboard write path that the
// sales-factory CREATE units (C4 contract generation / persistence) reuse: verify the caller's Supabase JWT
// -> confirm ACTIVE team member -> write via a service_role-only RPC, passing the AUTHENTICATED uid as the
// actor. The actor is derived from the verified JWT, NEVER from the request body — the client cannot forge
// who did it. Fails CLOSED.
//
// Reuses the Aegis-blessed log_activity RPC (migration 0009) AS-IS — no new migration, no new DB surface.
// log_activity is the real gate: it re-validates the actor is an active member, enforces the action token
// shape, bounds detail (flat object, <=4KB, <=30 keys, string values <=1000), and DB-layer secret-scans
// entity_type + detail keys/values. This endpoint validates early for clean 400s; the RPC is authoritative.
//
// Runtime: Cloudflare Workers. Server-side env (context.env, NOT VITE_): SUPABASE_SERVICE_ROLE_KEY
// (already set for /api/recall etc.). No Gemini key needed (no embed/generation).
//
// Deferred (pre-broad-rollout, per Unit-B pattern): per-user/IP rate limiting on writes.

import { createClient } from '@supabase/supabase-js'

const MAX_NOTE_LEN = 1000          // matches log_activity's per-string-value cap
const MAX_ACTION_LEN = 200         // matches log_activity's action cap
const MAX_ENTITY_TYPE_LEN = 100    // matches log_activity's entity_type cap
const ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/   // mirrors the RPC's namespaced-token rule
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_ACTION = 'work.note'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export const onRequestPost = async (context: any): Promise<Response> => {
  const env = context.env || {}
  const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const ANON = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
  const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !ANON || !SERVICE) return json({ error: 'server misconfigured' }, 500)

  // ---- parse + strict args (additionalProperties:false) ----
  let payload: any
  try { payload = await context.request.json() } catch { return json({ error: 'invalid JSON body' }, 400) }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return json({ error: 'body must be an object' }, 400)
  for (const key of Object.keys(payload)) {
    if (key !== 'note' && key !== 'action' && key !== 'entity_type' && key !== 'entity_id') {
      return json({ error: `unexpected field "${key}"` }, 400)
    }
  }

  // note: required non-empty string, bounded
  if (typeof payload.note !== 'string') return json({ error: '"note" must be a string' }, 400)
  const note = payload.note.trim()
  if (!note) return json({ error: '"note" must be non-empty' }, 400)
  if (note.length > MAX_NOTE_LEN) return json({ error: `"note" exceeds ${MAX_NOTE_LEN} chars` }, 400)

  // action: optional namespaced token; default work.note
  let action = DEFAULT_ACTION
  if (payload.action !== undefined) {
    if (typeof payload.action !== 'string') return json({ error: '"action" must be a string' }, 400)
    action = payload.action.trim()
    if (action.length > MAX_ACTION_LEN || !ACTION_RE.test(action)) {
      return json({ error: '"action" must be a namespaced token like "work.note"' }, 400)
    }
  }

  // entity_type / entity_id: optional linkage (e.g. tie a note to a deal/project)
  let entityType: string | null = null
  if (payload.entity_type !== undefined && payload.entity_type !== null) {
    if (typeof payload.entity_type !== 'string') return json({ error: '"entity_type" must be a string' }, 400)
    entityType = payload.entity_type.trim() || null
    if (entityType && entityType.length > MAX_ENTITY_TYPE_LEN) return json({ error: `"entity_type" exceeds ${MAX_ENTITY_TYPE_LEN} chars` }, 400)
  }
  let entityId: string | null = null
  if (payload.entity_id !== undefined && payload.entity_id !== null) {
    if (typeof payload.entity_id !== 'string' || !UUID_RE.test(payload.entity_id)) {
      return json({ error: '"entity_id" must be a uuid' }, 400)
    }
    entityId = payload.entity_id
  }

  // ---- authz: valid JWT -> active team member (fail closed) ----
  const authz = context.request.headers.get('authorization') || ''
  const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : ''
  if (!token) return json({ error: 'unauthorized' }, 401)

  const anon = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: userData, error: userErr } = await anon.auth.getUser(token)
  const uid = userData?.user?.id
  if (userErr || !uid) return json({ error: 'unauthorized' }, 401)

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: member, error: mErr } = await admin
    .from('team_members').select('id').eq('id', uid).eq('active', true).maybeSingle()
  if (mErr || !member) return json({ error: 'forbidden' }, 403)

  // ---- write: log_activity with actor = AUTHENTICATED uid (not from the body) ----
  // detail is a flat object; the RPC bounds size/keys/values and secret-scans. The note text is allowed
  // (it's a human work-note authored by the member), but high-signal secret patterns are still rejected.
  const { data: logId, error: wErr } = await admin.rpc('log_activity', {
    p_actor: uid,
    p_action: action,
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_detail: { note },
  })
  if (wErr) {
    // surface the RPC's validation message (e.g. secret detected, bad action) as a 400; generic otherwise
    const msg = wErr.message || ''
    if (/secret|action must|detail|too long|too many|must be/i.test(msg)) return json({ error: msg }, 400)
    return json({ error: 'write failed' }, 502)
  }

  return json({ id: logId, action, entity_type: entityType, entity_id: entityId }, 201)
}
// (Only onRequestPost is exported, so CF Pages auto-returns 405 for any non-POST method.)
