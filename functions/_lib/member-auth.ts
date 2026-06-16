// Mnemosyne — shared CF Pages Function helper: env + fail-closed member authz.
// Used by the C5 CRM write endpoints (and reusable elsewhere). Keeps the JWT→active-member check identical
// across endpoints. Service-role + anon clients are created here; secrets stay in context.env (never VITE_).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export type AuthOk = { ok: true; uid: string; admin: SupabaseClient }
export type AuthErr = { ok: false; res: Response }

// Verifies env + the caller's JWT + active membership. Returns the service-role client + uid on success,
// or a ready-to-return error Response (401/403/500) on failure. Fails CLOSED.
export async function requireMember(context: any): Promise<AuthOk | AuthErr> {
  const env = context.env || {}
  const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const ANON = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
  const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !ANON || !SERVICE) return { ok: false, res: json({ error: 'server misconfigured' }, 500) }

  const authz = context.request.headers.get('authorization') || ''
  const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : ''
  if (!token) return { ok: false, res: json({ error: 'unauthorized' }, 401) }

  const anon = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: userData, error: userErr } = await anon.auth.getUser(token)
  const uid = userData?.user?.id
  if (userErr || !uid) return { ok: false, res: json({ error: 'unauthorized' }, 401) }

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: member, error: mErr } = await admin
    .from('team_members').select('id').eq('id', uid).eq('active', true).maybeSingle()
  if (mErr || !member) return { ok: false, res: json({ error: 'forbidden' }, 403) }

  return { ok: true, uid, admin }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

// Parse JSON body + enforce additionalProperties:false over an allow-list. Returns the object or an error Response.
export async function parseStrict(context: any, allowed: string[]): Promise<{ ok: true; body: any } | { ok: false; res: Response }> {
  let payload: any
  try { payload = await context.request.json() } catch { return { ok: false, res: json({ error: 'invalid JSON body' }, 400) } }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { ok: false, res: json({ error: 'body must be an object' }, 400) }
  for (const k of Object.keys(payload)) if (!allowed.includes(k)) return { ok: false, res: json({ error: `unexpected field "${k}"` }, 400) }
  return { ok: true, body: payload }
}
