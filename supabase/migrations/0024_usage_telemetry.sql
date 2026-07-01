-- Mnemosyne — 0024: usage + token telemetry (thread 0025, P5-TELEMETRY). Additive.
-- UNAPPLIED until Aegis QC sign-off / apply-go.
--
-- Every later Pillar-5 optimization (fetch-scope, brief caps, agent diet, model tiering) needs a
-- baseline and a before/after. This adds one table + one write RPC:
--
--   * usage_events — one row per instrumented call: actor, source (mcp/endpoint/script), tool,
--     model (nullable — renders have none), provider token counts (nullable — proxy metrics for
--     embeds/renders), request/response byte sizes (proxy for Claude-side context cost, honest
--     labeling — NOT presented as exact tokens), ok flag, timestamp.
--   * log_usage(...) — service-role-only write. Validates source/tool against length + charset
--     caps, clamps ints to >= 0. NO free-text fields beyond tool/model — never logs query text,
--     titles, or bodies (standing rule from recall.ts's audit note).
--
-- Posture follows 0023's pattern exactly: RLS on, explicit revoke (this project auto-grants on
-- new public tables), members get SELECT-only so the dashboard can read rollups, writes gated by
-- grant not just policy convention.

create table if not exists public.usage_events (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid references public.team_members (id) on delete set null,
  source        text not null,        -- 'mcp' | 'endpoint' | 'script'
  tool          text not null,        -- e.g. 'recall', 'fetch', 'api/generate-contract'
  model         text,                 -- 'gemini-embedding-001', 'gemini-2.5-flash', null for render
  input_tokens  int,                  -- provider-reported, null when unknown
  output_tokens int,
  bytes_in      int,                  -- request payload size (proxy metric)
  bytes_out     int,                  -- response payload size
  ok            boolean not null default true,
  created_at    timestamptz not null default now()
);

alter table public.usage_events enable row level security;
revoke all on public.usage_events from anon, authenticated;

create policy usage_events_select on public.usage_events for select using (public.is_team_member());

create index if not exists usage_events_created_at_idx on public.usage_events (created_at desc);
create index if not exists usage_events_actor_tool_created_at_idx on public.usage_events (actor_id, tool, created_at desc);

create or replace function public.log_usage(
  p_actor uuid,
  p_source text,
  p_tool text,
  p_model text default null,
  p_input_tokens int default null,
  p_output_tokens int default null,
  p_bytes_in int default null,
  p_bytes_out int default null,
  p_ok boolean default true
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_source is null or p_source not in ('mcp', 'endpoint', 'script') then
    raise exception 'log_usage: bad source';
  end if;
  if p_tool is null or length(p_tool) = 0 or length(p_tool) > 128 or p_tool !~ '^[a-zA-Z0-9_./-]+$' then
    raise exception 'log_usage: bad tool';
  end if;
  if p_model is not null and (length(p_model) = 0 or length(p_model) > 64 or p_model !~ '^[a-zA-Z0-9_.-]+$') then
    raise exception 'log_usage: bad model';
  end if;

  insert into public.usage_events (
    actor_id, source, tool, model, input_tokens, output_tokens, bytes_in, bytes_out, ok
  ) values (
    p_actor, p_source, p_tool, p_model,
    greatest(p_input_tokens, 0), greatest(p_output_tokens, 0),
    greatest(p_bytes_in, 0), greatest(p_bytes_out, 0),
    coalesce(p_ok, true)
  )
  returning id into v_id;

  return v_id;
end $$;

revoke execute on function public.log_usage(uuid, text, text, text, int, int, int, int, boolean) from public, anon, authenticated;
grant  execute on function public.log_usage(uuid, text, text, text, int, int, int, int, boolean) to service_role;
