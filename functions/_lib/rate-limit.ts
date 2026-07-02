// Mnemosyne — shared rate-limit helper (thread 0024, Pillar 4 hygiene sprint).
// Wraps the Postgres token-bucket RPC `rate_take` (migration 0023) so any endpoint can cap
// per-actor spend with one call, right after auth and before the expensive work (embed/LLM/render).

import type { SupabaseClient } from '@supabase/supabase-js'
import { json } from './member-auth'

export type RateOk = { ok: true }
export type RateErr = { ok: false; res: Response }

export async function checkRateLimit(
  admin: SupabaseClient,
  actor: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateOk | RateErr> {
  const { data, error } = await admin.rpc('rate_take', {
    p_actor: actor,
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  })
  if (error) return { ok: false, res: json({ error: 'rate limit check failed' }, 500) }
  if (!data) {
    // Retry-After = the bucket's own window (rate_take returns boolean only, no per-caller estimate —
    // thread 0027 build instruction #3: a conservative constant is fine, not a precise refill time).
    const res = new Response(
      JSON.stringify({ error: 'rate limit exceeded — slow down and retry shortly' }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(windowSeconds) } },
    )
    return { ok: false, res }
  }
  return { ok: true }
}
