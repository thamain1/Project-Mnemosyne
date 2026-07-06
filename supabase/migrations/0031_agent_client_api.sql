-- Mnemosyne — 0031: Agent Context & Outcome API (docs/WORK-ORDER-AGENT-API.md). Additive.
-- UNAPPLIED until Aegis QC + Jesse apply-go.
--
-- Gives external agent systems (first consumer: IntelliService-ISB's dispatch/contract agents) a
-- service-token surface distinct from the hosted-MCP machine model (0026): agent_clients are scoped
-- to exactly two endpoints (agent-context read, agent-outcome write), namespaced per client via
-- memory tags, and carry NO tool surface / scopes array — they can never reach recall/remember/
-- get_secret etc. This is a narrower trust tier than a machine token, by design.
--
--   * agent_clients        — one row per external client (e.g. 'dunaway-isb-demo'), opaque bearer
--                            token (sha256 hash only, mirrors machine_tokens). Service-role only.
--   * verify_agent_client_token(hash) — same shape/atomicity discipline as verify_machine_token
--                            (0026): single UPDATE...FROM, bumps last_used_at, returns empty on ANY
--                            miss (unknown hash / inactive) so a bad token has no distinguishing oracle.
--   * a fixed system team_members row ("Agent API (system)") — the audit/rate-limit ACTOR for every
--     agent_clients call. Mirrors the existing "operator member" pattern (local MCP tools act as one
--     configured actor on behalf of many logical callers) rather than inventing a new identity type
--     that would need its own FKs through activity_log/rate_limits/memory_entries. Per-client
--     attribution lives in rate_limits' bucket string (agent_context:<slug> / agent_outcome:<slug>)
--     and in activity_log.detail.client_slug / memory_entries.tags — NOT in actor_id.
--   * record_agent_outcome(...) — ATOMIC write: always appends one activity_log row (action
--     agent.<event_type>, detail = the bounded payload — the durable audit trail per client), PLUS
--     OPTIONALLY (when the event carries reusable qualitative content) a tagged memory_entries row in
--     the SAME transaction, embedded (this is the "ingest path", so these entries stay findable via
--     normal team recall too). Distinct provenance family `agent/<client_slug>/<name>` (neither
--     `memory/` file-backed nor `mcp/` operator-authored) — its own ownership lane, consistent with
--     the dual-guard pattern in 0007/0009. Hard DB-level invariant: a memory payload's tags MUST
--     include `client:<p_client_slug>` exactly matching the authenticated caller's own slug — this is
--     the belt-and-suspenders backstop for "cross-client leakage is the one unforgivable bug here"
--     (WO §2), independent of whatever the app layer computed.

-- ── 1. agent_clients ────────────────────────────────────────────────────────────────────────────
create table if not exists public.agent_clients (
  client_slug   text primary key check (client_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  display_name  text not null,
  token_hash    text not null unique,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  notes         text
);

-- service-role-only: this project auto-grants anon/authenticated on new public tables — explicit
-- revoke per house standard (0026's machine_tokens comment). No dashboard surface yet (WO §1).
alter table public.agent_clients enable row level security;
revoke all on public.agent_clients from anon, authenticated;

-- ── 2. verify_agent_client_token — sole read+write path for token verification. Same atomicity/
--    non-oracle discipline as verify_machine_token (0026): unknown hash, inactive client, or a
--    malformed hash all return EMPTY, indistinguishably. ─────────────────────────────────────────
create or replace function public.verify_agent_client_token(p_hash text)
returns table (
  client_slug text,
  is_active   boolean
)
language plpgsql security definer set search_path = '' as $$
begin
  if p_hash is null or length(p_hash) <> 64 or p_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  return query
  update public.agent_clients c
  set last_used_at = now()
  where c.token_hash = p_hash
    and c.is_active
  returning c.client_slug, c.is_active;
end $$;

revoke execute on function public.verify_agent_client_token(text) from public, anon, authenticated;
grant  execute on function public.verify_agent_client_token(text) to service_role;

-- ── 3. Fixed system actor — the attribution row for every agent_clients call (see header). Idempotent
--    on id: a re-apply of this migration (should never happen, but matches house caution) can't create
--    a duplicate or clobber a hand-edited row. ───────────────────────────────────────────────────────
insert into public.team_members (id, full_name, email, kind, role, active, scopes)
values ('1788c353-8921-418b-9db4-fa8ca388c1b0', 'Agent API (system)', null, 'machine', 'member', true, '{}')
on conflict (id) do nothing;

-- ── 4. record_agent_outcome — atomic activity_log append + optional tagged memory_entries insert.
--    p_memory is null for activity-log-only events (WO §4: plain contract_won / contract_dismissed). ──
create or replace function public.record_agent_outcome(
  p_actor       uuid,
  p_client_slug text,
  p_action      text,
  p_detail      jsonb,
  p_memory      jsonb
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_activity_id uuid;
  v_memory_id   uuid;
  v_entity_type text;
  v_entity_id   uuid;
  v_name        text;
  v_kind        text;
  v_emb         text;
  v_norm        double precision;
  v_tags        text[];
  c_uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active and kind = 'machine') then
    raise exception 'record_agent_outcome: actor must be an active machine team member';
  end if;
  if p_client_slug is null or p_client_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'record_agent_outcome: bad client_slug';
  end if;
  if p_action is null or p_action !~ '^agent\.[a-z][a-z0-9_]*$' then
    raise exception 'record_agent_outcome: action must be "agent.<event_type>"';
  end if;

  -- best-effort informational entity linkage (no FK target; activity_log.entity_id has none either)
  v_entity_type := case
    when p_detail ? 'customer_id' and (p_detail->>'customer_id') ~* c_uuid_re then 'isb_customer'
    when p_detail ? 'tech_id'     and (p_detail->>'tech_id')     ~* c_uuid_re then 'isb_tech'
    else null
  end;
  v_entity_id := case
    when p_detail ? 'customer_id' and (p_detail->>'customer_id') ~* c_uuid_re then (p_detail->>'customer_id')::uuid
    when p_detail ? 'tech_id'     and (p_detail->>'tech_id')     ~* c_uuid_re then (p_detail->>'tech_id')::uuid
    else null
  end;

  -- log_activity re-validates actor/action/detail shape and secret-scans keys+values — the durable
  -- per-client audit row (detail carries client_slug, event_type, summary, customer/tech ids+names, ref).
  v_activity_id := public.log_activity(p_actor, p_action, v_entity_type, v_entity_id, p_detail);

  if p_memory is not null then
    if exists (select 1 from jsonb_object_keys(p_memory) k where k not in ('name','kind','title','body','tags')) then
      raise exception 'record_agent_outcome: unexpected key in memory payload';
    end if;
    v_name := p_memory->>'name';
    v_kind := p_memory->>'kind';
    if v_name is null or v_name !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_name) > 80 then
      raise exception 'record_agent_outcome: bad memory name';
    end if;
    if v_kind is null or v_kind not in ('user','feedback','project','reference') then
      raise exception 'record_agent_outcome: bad memory kind';
    end if;
    if jsonb_typeof(p_memory->'title') is distinct from 'string' or p_memory->>'title' = '' then
      raise exception 'record_agent_outcome: memory title must be a non-empty string';
    end if;
    if jsonb_typeof(p_memory->'body') is distinct from 'string' or p_memory->>'body' = '' then
      raise exception 'record_agent_outcome: memory body must be a non-empty string';
    end if;
    if jsonb_typeof(p_memory->'tags') is distinct from 'array' then
      raise exception 'record_agent_outcome: memory tags must be an array';
    end if;

    select coalesce(array_agg(value), '{}') into v_tags from jsonb_array_elements_text(p_memory->'tags') as value;
    if array_length(v_tags, 1) is null or array_length(v_tags, 1) > 10 then
      raise exception 'record_agent_outcome: memory tags must have 1-10 entries';
    end if;
    if exists (select 1 from unnest(v_tags) t where length(t) > 100 or t !~ '^[a-z][a-z0-9-]*:[A-Za-z0-9-]+$') then
      raise exception 'record_agent_outcome: memory tags must match "<namespace>:<value>"';
    end if;
    -- THE cross-client-leakage backstop (WO §2): the tag set must literally include the authenticated
    -- caller's own client_slug — independent of anything the app layer computed.
    if not (('client:' || p_client_slug) = any (v_tags)) then
      raise exception 'record_agent_outcome: memory tags must include client:%', p_client_slug;
    end if;

    -- embedding required (this is "the ingest path" — keeps these entries findable via normal recall)
    v_emb := p_memory->>'embedding';
    if jsonb_typeof(p_memory->'embedding') is distinct from 'string' then
      raise exception 'record_agent_outcome: embedding must be a non-null string';
    end if;
    if public.vector_dims((v_emb)::public.vector) <> 768 then raise exception 'record_agent_outcome: embedding not 768-dim'; end if;
    v_norm := public.vector_norm((v_emb)::public.vector);
    if v_norm = 0 or abs(v_norm - 1) > 1e-3 then raise exception 'record_agent_outcome: embedding not unit-normalized (norm=%)', v_norm; end if;

    insert into public.memory_entries (name, kind, title, body, links, source_path, embedding_model, embedding, tags, created_by)
    values (
      v_name, v_kind::public.memory_kind, p_memory->>'title', p_memory->>'body', '{}',
      'agent/' || p_client_slug || '/' || v_name, 'gemini-embedding-001', (v_emb)::public.vector, v_tags, p_actor
    )
    on conflict (name) do nothing
    returning id into v_memory_id;
    if v_memory_id is null then raise exception 'record_agent_outcome: name "%" already exists', v_name; end if;
  end if;

  return jsonb_build_object('activity_id', v_activity_id, 'memory_id', v_memory_id);
end $$;

revoke execute on function public.record_agent_outcome(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function public.record_agent_outcome(uuid, text, text, jsonb, jsonb) to service_role;
