-- Mnemosyne — 0021: MCP read-body + safe update subsystem. Additive. UNAPPLIED until Aegis QC sign-off.
--
-- Closes the gap a remote operator hit: `recall` returns metadata only (name/title/similarity/freshness),
-- so an agent can FIND an entry but never READ it — and therefore can't faithfully fold an old entry's
-- detail into a revision without risking a blind, irreversible overwrite of a shared resource it didn't
-- create. This migration adds three definer-only primitives:
--
--   * get_memory_entry(p_name)  — SELECT-only read-body RPC. `recall` hands you the exact name; this hands
--     you the full stored body + metadata for that one entry. SECURITY DEFINER, empty search_path,
--     fully-qualified, service_role-only. No body/secret leakage concern: bodies are secret-scanned on the
--     way IN (remember refuses secrets; ingestion quarantines secret-bearing files), so the store is
--     secret-free by invariant.
--
--   * memory_versions           — append-only history. Before every update_memory overwrites an entry, the
--     PRIOR content state is snapshotted here, so every update is reversible and auditable. Content-only
--     snapshot (no embeddings): a revert re-embeds the restored body via the normal update path.
--
--   * update_memory(...)        — ATOMIC, optimistic-concurrency-guarded update of an EXISTING entry
--     (canonical memory/ OR operator mcp/). In ONE transaction: lock the row → assert the caller's
--     expected updated_at (reject if it moved) → snapshot prior state to memory_versions → apply the new
--     content + re-embedding (same vector validation as remember_memory) → reconcile chunks → write an
--     atomic audit row. Provenance (source_path), project linkage, and sensitivity are IMMUTABLE on update;
--     only content + embedding + classification (kind/links) change. Bounded fan-out (MAX_CHUNKS=12).
--     update_memory only UPDATES — it never creates (use remember for new entries), so it cannot be used to
--     conjure an arbitrary entry; it can only revise one that already exists.
--     p_expected_updated_at is MANDATORY (Aegis 0022 #1): a NULL is rejected, so an agent CANNOT update any
--     entry without first reading it (fetch) and presenting the timestamp it saw. canonical memory/ updates
--     additionally REQUIRE a change_reason (Aegis 0022 hardening).
--
-- SOURCE-OF-TRUTH RULE (Aegis 0022 hardening — read before relying on update for canonical entries):
--   For file-backed canonical memory/<file>.md entries, the LOCAL .md file remains the source of truth. A
--   DB update via update_memory is a *reversible hotfix* (prior state preserved in memory_versions), but a
--   subsequent file re-ingest (ingest_memory_entry over the unchanged .md) WILL overwrite the DB hotfix.
--   There is no divergence guard yet; to make a canonical change durable, also edit the .md source. mcp/<slug>
--   operator entries have no file backing, so their updates are authoritative.

-- ── get_memory_entry: read-body RPC (the counterpart to metadata-only recall) ──────────────────────────
-- Exact-name lookup, parameterized (injection-safe). Not found → zero rows (the Node layer reports it).
-- Returns the full body + classification + provenance + freshness + sensitivity, but NOT the embedding
-- (large, useless to a caller). STABLE, read-only.
create or replace function public.get_memory_entry(p_name text)
returns table (
  name        text,
  kind        text,
  title       text,
  body        text,
  links       text[],
  source_path text,
  sensitivity text,
  created_at  timestamptz,
  updated_at  timestamptz
)
language sql security definer set search_path = '' stable as $$
  select e.name, e.kind::text, e.title, e.body, e.links,
         e.source_path, e.sensitivity::text, e.created_at, e.updated_at
  from public.memory_entries e
  where e.name = p_name
  limit 1
$$;

-- ── memory_versions: append-only prior-state history ───────────────────────────────────────────────────
create table if not exists public.memory_versions (
  id            uuid primary key default gen_random_uuid(),
  entry_id      uuid not null references public.memory_entries (id) on delete cascade,
  version_no    int  not null,                      -- monotonic per entry; assigned under the entry row lock
  name          text not null,
  kind          public.memory_kind not null,
  title         text not null,
  body          text not null,
  links         text[] not null default '{}',
  source_path   text,
  sensitivity   public.sensitivity_tier not null default 'team',
  edited_by     uuid references public.team_members (id),
  change_reason text,
  created_at    timestamptz not null default now(),
  unique (entry_id, version_no)
);
create index if not exists idx_memory_versions_entry on public.memory_versions (entry_id);

-- ACL: SERVICE-ROLE-ONLY reads for now (Aegis 0022 #3). memory_versions stores prior FULL bodies, which can
-- preserve secret-contaminated content even after the live entry is cleaned (incident 0006 class). Until
-- history is exposed through a controlled RPC with an egress secret scan, no client role may read it: RLS on
-- with NO select policy + an explicit REVOKE from anon/authenticated (this project auto-grants new public
-- tables). service_role bypasses RLS for the definer update_memory write path; humans get history via a
-- future scanned RPC, not raw table reads.
alter table public.memory_versions enable row level security;
revoke all on public.memory_versions from anon, authenticated;

-- ── update_memory: atomic, concurrency-safe, versioned update of an existing entry ──────────────────────
-- payload key allow-list intentionally has NO source_path: provenance is immutable across updates (an
-- update to a canonical memory/<file>.md entry stays canonical; an mcp/<slug> entry stays operator-authored).
create or replace function public.update_memory(p_payload jsonb, p_actor uuid, p_audit jsonb, p_expected_updated_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name  text := p_payload->>'name';
  v_kind  text := p_payload->>'kind';
  v_model text := p_payload->>'embedding_model';
  v_emb   text := p_payload->>'embedding';
  v_has_chunks boolean;
  v_chunk jsonb;
  v_expected int := 0;
  v_norm double precision;
  v_entry public.memory_entries%rowtype;
  v_version int;
  v_reason text := nullif(p_audit->>'change_reason', '');
  c_max_chunks constant int := 12;   -- hard fan-out bound, mirrors remember_memory (Aegis 0007 #3)
begin
  -- actor: active team member, fail closed (re-validated inside log_activity; checked early to avoid work)
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'update_memory: actor must be an active team member';
  end if;
  -- MANDATORY optimistic-concurrency token (Aegis 0022 #1): no NULL "accept current state" path — an update
  -- must always present the updated_at it read, so blind canonical (or any) overwrite is structurally impossible.
  if p_expected_updated_at is null then
    raise exception 'update_memory: expected_updated_at is required — fetch the entry first and pass the updated_at you saw';
  end if;
  if v_reason is not null and length(v_reason) > 1000 then raise exception 'update_memory: change_reason too long (>1000)'; end if;

  -- payload validation — identical discipline to remember_memory, minus source_path (immutable on update)
  if exists (select 1 from jsonb_object_keys(p_payload) k
             where k not in ('name','kind','title','body','links','embedding_model','embedding','chunks')) then
    raise exception 'update_memory: unexpected key in payload';
  end if;
  if v_name is null or v_name !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_name) > 80 then raise exception 'bad name: %', v_name; end if;
  if v_kind is null or v_kind not in ('user','feedback','project','reference') then raise exception 'bad kind: %', v_kind; end if;
  if v_model is distinct from 'gemini-embedding-001' then raise exception 'bad embedding_model'; end if;
  if jsonb_typeof(p_payload->'title') is distinct from 'string' or p_payload->>'title' = '' then raise exception 'title must be a non-empty string'; end if;
  if jsonb_typeof(p_payload->'body')  is distinct from 'string' or p_payload->>'body'  = '' then raise exception 'body must be a non-empty string'; end if;
  if jsonb_typeof(p_payload->'links') is distinct from 'array' then raise exception 'links must be an array'; end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'links') e where jsonb_typeof(e) <> 'string') then raise exception 'links must contain only strings'; end if;

  if jsonb_typeof(p_payload->'chunks') is distinct from 'array' then raise exception 'chunks must be an array'; end if;
  if jsonb_array_length(p_payload->'chunks') > c_max_chunks then raise exception 'update_memory: too many chunks (max %)', c_max_chunks; end if;
  v_has_chunks := jsonb_array_length(p_payload->'chunks') > 0;

  if v_has_chunks then
    if v_emb is not null then raise exception 'chunked entry must have null embedding'; end if;
    for v_chunk in select value from jsonb_array_elements(p_payload->'chunks') as value loop
      if not (v_chunk ? 'chunk_index' and v_chunk ? 'content' and v_chunk ? 'embedding' and v_chunk ? 'embedding_model') then raise exception 'chunk missing a required key'; end if;
      if exists (select 1 from jsonb_object_keys(v_chunk) k where k not in ('chunk_index','content','embedding','embedding_model')) then raise exception 'unexpected key in chunk'; end if;
      if jsonb_typeof(v_chunk->'chunk_index') <> 'number' then raise exception 'chunk_index must be a number'; end if;
      if (v_chunk->'chunk_index')::text ~ '[.eE]'
         or (v_chunk->>'chunk_index')::numeric < 0
         or (v_chunk->>'chunk_index')::numeric <> floor((v_chunk->>'chunk_index')::numeric)
         or (v_chunk->>'chunk_index')::numeric > 1000000 then raise exception 'chunk_index must be a nonnegative integer <= 1000000'; end if;
      if jsonb_typeof(v_chunk->'content') <> 'string' or v_chunk->>'content' = '' then raise exception 'chunk content must be a non-empty string'; end if;
      if jsonb_typeof(v_chunk->'embedding') <> 'string' then raise exception 'chunk embedding must be a non-null string'; end if;
      if jsonb_typeof(v_chunk->'embedding_model') <> 'string' or (v_chunk->>'embedding_model') <> 'gemini-embedding-001' then raise exception 'bad chunk embedding_model'; end if;
      if (v_chunk->>'chunk_index')::int <> v_expected then raise exception 'non-contiguous chunk_index (expected %)', v_expected; end if;
      if public.vector_dims((v_chunk->>'embedding')::public.vector) <> 768 then raise exception 'chunk embedding not 768-dim'; end if;
      v_norm := public.vector_norm((v_chunk->>'embedding')::public.vector);
      if v_norm = 0 or abs(v_norm - 1) > 1e-3 then raise exception 'chunk embedding not unit-normalized (norm=%)', v_norm; end if;
      v_expected := v_expected + 1;
    end loop;
  else
    if jsonb_typeof(p_payload->'embedding') is distinct from 'string' then raise exception 'unchunked entry needs a non-null string embedding'; end if;
    if public.vector_dims((v_emb)::public.vector) <> 768 then raise exception 'embedding not 768-dim'; end if;
    v_norm := public.vector_norm((v_emb)::public.vector);
    if v_norm = 0 or abs(v_norm - 1) > 1e-3 then raise exception 'embedding not unit-normalized (norm=%)', v_norm; end if;
  end if;

  -- LOCK the target row: serializes concurrent updates to this entry AND is our optimistic-concurrency anchor.
  select * into v_entry from public.memory_entries where name = v_name for update;
  if not found then
    raise exception 'update_memory: no entry named "%" — use remember to create it (update never creates)', v_name;
  end if;

  -- optimistic concurrency: caller asserts the updated_at it read; reject if the row moved underneath it.
  if v_entry.updated_at is distinct from p_expected_updated_at then
    raise exception 'update_memory: "%" changed since you read it (you saw %, now %) — re-read and retry', v_name, p_expected_updated_at, v_entry.updated_at;
  end if;

  -- canonical file-backed entries REQUIRE a change_reason (Aegis 0022 hardening): a DB hotfix to a memory/
  -- entry diverges from its .md source-of-truth, so the rationale must be recorded. mcp/ entries are exempt.
  if v_entry.source_path ~ '^memory/' and v_reason is null then
    raise exception 'update_memory: change_reason is required when updating a canonical memory/ entry';
  end if;

  -- snapshot PRIOR state to history BEFORE overwriting (reversible + auditable). version_no assigned under
  -- the row lock above, so it's race-free.
  select coalesce(max(version_no), 0) + 1 into v_version from public.memory_versions where entry_id = v_entry.id;
  insert into public.memory_versions (entry_id, version_no, name, kind, title, body, links, source_path, sensitivity, edited_by, change_reason)
  values (v_entry.id, v_version, v_entry.name, v_entry.kind, v_entry.title, v_entry.body, v_entry.links, v_entry.source_path, v_entry.sensitivity, p_actor, v_reason);

  -- apply the update — content + embedding + classification only. source_path / project_id / sensitivity
  -- are deliberately left untouched (provenance is immutable on update).
  update public.memory_entries set
    kind  = v_kind::public.memory_kind,
    title = p_payload->>'title',
    body  = p_payload->>'body',
    links = coalesce((select array_agg(value) from jsonb_array_elements_text(p_payload->'links') as value), '{}'),
    embedding_model = v_model,
    embedding = case when v_has_chunks then null else (v_emb)::public.vector end,
    updated_at = now()
  where id = v_entry.id;

  delete from public.memory_chunks where memory_entry_id = v_entry.id;
  if v_has_chunks then
    insert into public.memory_chunks (memory_entry_id, chunk_index, content, embedding, embedding_model)
    select v_entry.id, (c->>'chunk_index')::int, c->>'content', (c->>'embedding')::public.vector, c->>'embedding_model'
    from jsonb_array_elements(p_payload->'chunks') as c;
  end if;

  -- ATOMIC audit in the SAME transaction (Aegis 0007 #2): log_activity re-validates actor + secret-scans
  -- detail; any failure raises and rolls back the update + snapshot above. detail = safe metadata only.
  perform public.log_activity(p_actor, 'memory.update', 'memory_entries', v_entry.id, coalesce(p_audit, '{}'::jsonb));
  return jsonb_build_object('id', v_entry.id, 'name', v_name, 'version_no', v_version, 'prior_updated_at', v_entry.updated_at);
end $$;

-- ── least-privilege execute (service_role only; never anon/authenticated) ───────────────────────────────
revoke execute on function public.get_memory_entry(text)                              from public, anon, authenticated;
revoke execute on function public.update_memory(jsonb, uuid, jsonb, timestamptz)      from public, anon, authenticated;
grant  execute on function public.get_memory_entry(text)                              to service_role;
grant  execute on function public.update_memory(jsonb, uuid, jsonb, timestamptz)      to service_role;
