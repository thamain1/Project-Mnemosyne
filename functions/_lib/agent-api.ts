// Mnemosyne — shared helper for the Agent Context & Outcome API (docs/WORK-ORDER-AGENT-API.md,
// migration 0031). External agent-system service tokens (agent_clients) are a narrower trust tier
// than hosted-MCP machine tokens: an opaque bearer resolves to a client_slug, nothing else — no tool
// surface, no scopes array. These tokens can reach exactly the two endpoints that import this file.
//
// Reuses json/isUuid from member-auth.ts (generic, not JWT-specific) rather than duplicating them.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { json } from './member-auth'

// The fixed "Agent API (system)" team_members row (migration 0031) — the audit/rate-limit ACTOR for
// every agent_clients call. Per-client attribution lives in rate_limits' bucket string and in
// activity_log.detail / memory_entries.tags, never in actor_id (see the migration header for why).
export const SYSTEM_ACTOR_ID = '1788c353-8921-418b-9db4-fa8ca388c1b0'

// Pre-parse cap: an agt_ token is a short opaque string; 200 chars is generous headroom without
// inviting abuse (mirrors mcp.ts's MAX_AUTHZ_HEADER_LEN reasoning at a smaller scale).
const MAX_TOKEN_LEN = 200

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type AgentAuthOk = { ok: true; clientSlug: string; admin: SupabaseClient }
export type AgentAuthErr = { ok: false; res: Response }

// Verifies env + the caller's opaque bearer token against agent_clients. Returns the service-role
// client + the resolved client_slug on success, or a ready-to-return error Response on failure.
// Fails CLOSED: malformed/unknown/inactive tokens all produce the SAME 401 (no distinguishing oracle).
export async function requireAgentClient(context: any): Promise<AgentAuthOk | AgentAuthErr> {
  const env = context.env || {}
  const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SERVICE) return { ok: false, res: json({ error: 'server misconfigured' }, 500) }

  const authz = context.request.headers.get('authorization') || ''
  const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : ''
  if (!token || token.length > MAX_TOKEN_LEN) return { ok: false, res: json({ error: 'unauthorized' }, 401) }

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
  const hash = await sha256Hex(token)
  const { data: rows, error } = await admin.rpc('verify_agent_client_token', { p_hash: hash })
  const verified: any = Array.isArray(rows) ? rows[0] : rows
  if (error || !verified || !verified.is_active) return { ok: false, res: json({ error: 'unauthorized' }, 401) }

  return { ok: true, clientSlug: verified.client_slug as string, admin }
}
