-- Mnemosyne — 0023: per-actor rate limiting (thread 0024, Pillar 4 hygiene sprint). Additive.
-- UNAPPLIED until Aegis QC sign-off.
--
-- Every endpoint that spends real money/tokens (Gemini embeddings, LLM generation, Cloudflare
-- Browser Rendering) or writes to the activity feed has deferred rate limiting since it shipped
-- (see recall.ts / log-update.ts / generate-contract.ts / render-document.ts headers). Both
-- MCP-PHASE2-PLAN.md (§6 P2-3) and 0024's Pillar 4 call this a hard prerequisite before any
-- fan-out (remote MCP, machine accounts) — not optional. This adds one reusable primitive:
--
--   * rate_limits  — one row per (actor, bucket): current token count + last-refill timestamp.
--   * rate_take(actor, bucket, limit, window_seconds) — atomic token-bucket take-or-reject.
--     Continuous refill at limit/window_seconds tokens/sec, capped at `limit`. Returns true if a
--     token was available (and consumes it), false if the caller should be rejected (429). The
--     row is locked with SELECT ... FOR UPDATE so concurrent calls for the same actor+bucket
--     serialize correctly — same atomicity discipline as update_memory (0021) and log_activity.
--
-- Callers pass their own (bucket, limit, window) per endpoint — this migration does not hardcode
-- policy, so limits can be tuned per endpoint without a schema change.

create table if not exists public.rate_limits (
  actor_id    uuid not null references public.team_members (id) on delete cascade,
  bucket      text not null,
  tokens      double precision not null,
  updated_at  timestamptz not null default now(),
  primary key (actor_id, bucket)
);

-- service-role-only: this is bookkeeping, not company knowledge; no client role needs to read or
-- write it directly (this project auto-grants new public tables — explicit revoke per standard).
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

create or replace function public.rate_take(p_actor uuid, p_bucket text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_tokens double precision;
  v_last   timestamptz;
  v_rate   double precision;
  v_now    timestamptz := now();
begin
  if p_actor is null then raise exception 'rate_take: actor required'; end if;
  if p_bucket is null or length(p_bucket) = 0 or length(p_bucket) > 64 then raise exception 'rate_take: bad bucket'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100000 then raise exception 'rate_take: bad limit'; end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then raise exception 'rate_take: bad window'; end if;
  v_rate := p_limit::double precision / p_window_seconds;

  -- seed a full bucket on first use for this actor+bucket; no-op if the row already exists.
  insert into public.rate_limits (actor_id, bucket, tokens, updated_at)
  values (p_actor, p_bucket, p_limit, v_now)
  on conflict (actor_id, bucket) do nothing;

  select tokens, updated_at into v_tokens, v_last
  from public.rate_limits where actor_id = p_actor and bucket = p_bucket for update;

  -- refill proportional to elapsed time since last take, capped at the bucket limit
  v_tokens := least(p_limit::double precision, v_tokens + extract(epoch from (v_now - v_last)) * v_rate);

  if v_tokens < 1 then
    update public.rate_limits set tokens = v_tokens, updated_at = v_now where actor_id = p_actor and bucket = p_bucket;
    return false;
  end if;

  update public.rate_limits set tokens = v_tokens - 1, updated_at = v_now where actor_id = p_actor and bucket = p_bucket;
  return true;
end $$;

revoke execute on function public.rate_take(uuid, text, int, int) from public, anon, authenticated;
grant  execute on function public.rate_take(uuid, text, int, int) to service_role;
