-- Mnemosyne — 0027: P2-BRIDGE + P2-CRM + P1-HYBRID lead-gen foundation (thread 0032). Additive.
-- UNAPPLIED until Aegis post-build QC + Jesse apply-go. Deploy order (0024 standing rule): apply this
-- migration → prove the OLD recall_memory(vector,int) still serves already-deployed code untouched →
-- THEN push the code that switches callers to recall_memory_hybrid. This migration does NOT touch,
-- replace, or overload recall_memory(vector,int) anywhere.
--
-- Two deliberate implementation decisions NOT spelled out verbatim in the design doc, made here to
-- reconcile it with `log_activity`'s ACTUAL (already-hardened) constraints — flagged, not silently
-- decided:
--   1. log_activity requires a non-null actor referencing an active team member ("p_actor is null OR
--      not exists ... -> raise exception"). The design's stale-deals digest wants `actor_id = null`
--      ("no system actor exists — documented deliberately"). Calling log_activity(null, ...) as
--      written today would always raise. Fix: a minimal, exact-string-matched carve-out — null actor
--      is permitted ONLY when p_action = 'crm.stale_deals'. Every other caller/action keeps the
--      original fail-closed behavior unchanged. This preserves ONE audit-writing code path (every
--      activity_log row still goes through log_activity's validation) rather than duplicating its
--      ~15 lines of bounds/secret-scan logic in a second insert path.
--   2. log_activity also requires `detail` to be FLAT (no nested object/array values) — but the
--      design's digest detail shape is `{source, digest_date, deals:[{title,days_stale}...]}`, which
--      has a nested array and would be rejected outright. Fix: the deals list is carried as a single
--      JSON-encoded STRING value (`deals_json`), not a nested array — every value in the resulting
--      detail object is a string or number, satisfying the flatness constraint exactly as written,
--      with zero change to that check. A `stale_count` field carries the count without needing to
--      parse the string. Consumers (the Activity feed, `brief`) JSON.parse `deals_json` client-side.
--
-- Fix round (Aegis post-build QC, 2026-07-02 — 1 blocker, fixed before apply/push):
--   `ingest_memory_entry`'s ON CONFLICT clause originally always overwrote client_id/deal_id from the
--   incoming payload, so a canonical memory/*.md re-ingest that omits bridge fields would silently
--   unlink the entry from its client/deal. Fixed to mirror update_memory's omitted-vs-explicit-null
--   convention: key absent -> preserve existing link; key present (even as null) -> apply the new
--   value. See A2 inline comment at the ON CONFLICT clause.

-- ═══════════════════════════════════ PART A — P2-BRIDGE ═══════════════════════════════════════════

-- ── A1. memories ↔ CRM linkage columns. Nullable, no link table in v1 (an entry is about at most one
--    client/deal in practice — documented v2 escape hatch if that assumption ever breaks). Mirrors the
--    project_id precedent from migration 0030. ──────────────────────────────────────────────────────
alter table public.memory_entries
  add column if not exists client_id uuid references public.clients (id) on delete set null,
  add column if not exists deal_id   uuid references public.deals   (id) on delete set null;
create index if not exists memory_entries_client_id_idx on public.memory_entries (client_id) where client_id is not null;
create index if not exists memory_entries_deal_id_idx   on public.memory_entries (deal_id)   where deal_id is not null;

-- documents.deal_id already exists (migration 0015) — verified against live schema 2026-07-02, add
-- only what's missing: client_id. The existing documents_deal_id_idx (0015, non-partial) is reused
-- as-is rather than duplicated with a redundant partial index.
alter table public.documents
  add column if not exists client_id uuid references public.clients (id) on delete set null;
create index if not exists documents_client_id_idx on public.documents (client_id) where client_id is not null;

-- ── A2. ingest_memory_entry — extend BOTH overloaded bodies (operator mcp/ provenance AND file-backed
--    memory/ provenance) with optional client_id/deal_id. Everything else (validation order, chunk
--    handling, ON CONFLICT ownership policy) is byte-for-byte unchanged from 0009/0021. ─────────────
create or replace function public.ingest_memory_entry(payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_id  uuid;
  v_name  text := payload->>'name';
  v_kind  text := payload->>'kind';
  v_model text := payload->>'embedding_model';
  v_path  text := payload->>'source_path';
  v_emb   text := payload->>'embedding';
  v_client_id uuid := nullif(payload->>'client_id','')::uuid;
  v_deal_id   uuid := nullif(payload->>'deal_id','')::uuid;
  v_slug  text;
  v_has_chunks boolean;
  v_chunk jsonb;
  v_expected int := 0;
  v_norm double precision;
begin
  if exists (select 1 from jsonb_object_keys(payload) k
             where k not in ('name','kind','title','body','links','source_path','embedding_model','embedding','chunks','client_id','deal_id')) then
    raise exception 'ingest_memory_entry: unexpected key in payload';
  end if;
  if v_name is null or v_name !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'bad name: %', v_name; end if;
  if v_kind is null or v_kind not in ('user','feedback','project','reference') then raise exception 'bad kind: %', v_kind; end if;
  if v_model is distinct from 'gemini-embedding-001' then raise exception 'bad embedding_model'; end if;
  if jsonb_typeof(payload->'title') is distinct from 'string' or payload->>'title' = '' then raise exception 'title must be a non-empty string'; end if;
  if jsonb_typeof(payload->'body')  is distinct from 'string' or payload->>'body'  = '' then raise exception 'body must be a non-empty string'; end if;
  if jsonb_typeof(payload->'links') is distinct from 'array' then raise exception 'links must be an array'; end if;
  if exists (select 1 from jsonb_array_elements(payload->'links') e where jsonb_typeof(e) <> 'string') then raise exception 'links must contain only strings'; end if;
  if v_client_id is not null and not exists (select 1 from public.clients where id = v_client_id) then raise exception 'ingest_memory_entry: client % not found', v_client_id; end if;
  if v_deal_id   is not null and not exists (select 1 from public.deals   where id = v_deal_id)   then raise exception 'ingest_memory_entry: deal % not found', v_deal_id; end if;

  if v_path is null or v_path !~ '^memory/[A-Za-z0-9._-]+\.md$' then raise exception 'bad source_path'; end if;
  v_slug := trim(both '-' from regexp_replace(lower(regexp_replace(substring(v_path from '^memory/(.*)$'), '\.md$', '', 'i')), '[^a-z0-9]+', '-', 'g'));
  if v_slug is distinct from v_name then raise exception 'source_path slug (%) != name (%)', v_slug, v_name; end if;

  if jsonb_typeof(payload->'chunks') is distinct from 'array' then raise exception 'chunks must be an array'; end if;
  v_has_chunks := jsonb_array_length(payload->'chunks') > 0;

  if v_has_chunks then
    if v_emb is not null then raise exception 'chunked entry must have null embedding'; end if;
    for v_chunk in select value from jsonb_array_elements(payload->'chunks') as value loop
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
    if jsonb_typeof(payload->'embedding') is distinct from 'string' then raise exception 'unchunked entry needs a non-null string embedding'; end if;
    if public.vector_dims((v_emb)::public.vector) <> 768 then raise exception 'embedding not 768-dim'; end if;
    v_norm := public.vector_norm((v_emb)::public.vector);
    if v_norm = 0 or abs(v_norm - 1) > 1e-3 then raise exception 'embedding not unit-normalized (norm=%)', v_norm; end if;
  end if;

  insert into public.memory_entries (name, kind, title, body, links, source_path, embedding_model, embedding, client_id, deal_id)
  values (
    v_name, v_kind::public.memory_kind, payload->>'title', payload->>'body',
    coalesce((select array_agg(value) from jsonb_array_elements_text(payload->'links') as value), '{}'),
    v_path, v_model,
    case when v_has_chunks then null else (v_emb)::public.vector end,
    v_client_id, v_deal_id
  )
  -- fix round (Aegis post-build QC, 2026-07-02): client_id/deal_id use the SAME omitted-vs-explicit-
  -- null convention as update_memory (lines ~224-228) — a key ABSENT from payload preserves whatever
  -- link the row already has; a key PRESENT (including present-with-null) applies the new value. A
  -- source-file re-ingest that doesn't mention bridge fields must never silently unlink a memory from
  -- its client/deal.
  on conflict (name) do update set
    kind = excluded.kind, title = excluded.title, body = excluded.body, links = excluded.links,
    source_path = excluded.source_path, embedding_model = excluded.embedding_model,
    embedding = excluded.embedding,
    client_id = case when payload ? 'client_id' then excluded.client_id else public.memory_entries.client_id end,
    deal_id   = case when payload ? 'deal_id'   then excluded.deal_id   else public.memory_entries.deal_id   end,
    updated_at = now()
    where public.memory_entries.source_path ~ '^memory/'
  returning id into v_id;
  if v_id is null then raise exception 'ingest_memory_entry: name "%" collides with a non-file (operator/mcp) entry', v_name; end if;

  delete from public.memory_chunks where memory_entry_id = v_id;
  if v_has_chunks then
    insert into public.memory_chunks (memory_entry_id, chunk_index, content, embedding, embedding_model)
    select v_id, (c->>'chunk_index')::int, c->>'content', (c->>'embedding')::public.vector, c->>'embedding_model'
    from jsonb_array_elements(payload->'chunks') as c;
  end if;
end $$;

-- ── A3. update_memory — extend with optional p_client_id/p_deal_id link params. Content-update
--    validation/versioning/optimistic-concurrency logic is UNCHANGED from 0021; the only additions are
--    the two new keys, their FK validation, and the memory.link audit rows (r2, per Aegis clarification
--    #3): memory_versions stays CONTENT-only (unchanged schema, no link snapshot); a link change is
--    audited via log_activity instead, action 'memory.link', one row per changed field. A link-only
--    update still bumps updated_at (it goes through the exact same UPDATE statement as a content
--    change) and still requires expected_updated_at (unchanged — the mandatory-concurrency check runs
--    before any link comparison). ─────────────────────────────────────────────────────────────────────
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
  v_new_client_id uuid;
  v_new_deal_id   uuid;
  c_max_chunks constant int := 12;   -- hard fan-out bound, mirrors remember_memory (Aegis 0007 #3)
begin
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'update_memory: actor must be an active team member';
  end if;
  if p_expected_updated_at is null then
    raise exception 'update_memory: expected_updated_at is required — fetch the entry first and pass the updated_at you saw';
  end if;
  if v_reason is not null and length(v_reason) > 1000 then raise exception 'update_memory: change_reason too long (>1000)'; end if;

  if exists (select 1 from jsonb_object_keys(p_payload) k
             where k not in ('name','kind','title','body','links','embedding_model','embedding','chunks','client_id','deal_id')) then
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

  select * into v_entry from public.memory_entries where name = v_name for update;
  if not found then
    raise exception 'update_memory: no entry named "%" — use remember to create it (update never creates)', v_name;
  end if;

  if v_entry.updated_at is distinct from p_expected_updated_at then
    raise exception 'update_memory: "%" changed since you read it (you saw %, now %) — re-read and retry', v_name, p_expected_updated_at, v_entry.updated_at;
  end if;

  if v_entry.source_path ~ '^memory/' and v_reason is null then
    raise exception 'update_memory: change_reason is required when updating a canonical memory/ entry';
  end if;

  -- link params: if the key is present in the payload use it (including an explicit null to clear);
  -- if absent, keep the existing value (this is NOT a full replace of the whole payload — only
  -- title/body/kind/links/embedding are always-required; client_id/deal_id are link-only optionals).
  v_new_client_id := case when p_payload ? 'client_id' then nullif(p_payload->>'client_id','')::uuid else v_entry.client_id end;
  v_new_deal_id   := case when p_payload ? 'deal_id'   then nullif(p_payload->>'deal_id','')::uuid   else v_entry.deal_id   end;
  if v_new_client_id is not null and not exists (select 1 from public.clients where id = v_new_client_id) then raise exception 'update_memory: client % not found', v_new_client_id; end if;
  if v_new_deal_id   is not null and not exists (select 1 from public.deals   where id = v_new_deal_id)   then raise exception 'update_memory: deal % not found', v_new_deal_id; end if;

  select coalesce(max(version_no), 0) + 1 into v_version from public.memory_versions where entry_id = v_entry.id;
  insert into public.memory_versions (entry_id, version_no, name, kind, title, body, links, source_path, sensitivity, edited_by, change_reason)
  values (v_entry.id, v_version, v_entry.name, v_entry.kind, v_entry.title, v_entry.body, v_entry.links, v_entry.source_path, v_entry.sensitivity, p_actor, v_reason);

  update public.memory_entries set
    kind  = v_kind::public.memory_kind,
    title = p_payload->>'title',
    body  = p_payload->>'body',
    links = coalesce((select array_agg(value) from jsonb_array_elements_text(p_payload->'links') as value), '{}'),
    embedding_model = v_model,
    embedding = case when v_has_chunks then null else (v_emb)::public.vector end,
    client_id = v_new_client_id,
    deal_id = v_new_deal_id,
    updated_at = now()
  where id = v_entry.id;

  delete from public.memory_chunks where memory_entry_id = v_entry.id;
  if v_has_chunks then
    insert into public.memory_chunks (memory_entry_id, chunk_index, content, embedding, embedding_model)
    select v_entry.id, (c->>'chunk_index')::int, c->>'content', (c->>'embedding')::public.vector, c->>'embedding_model'
    from jsonb_array_elements(p_payload->'chunks') as c;
  end if;

  perform public.log_activity(p_actor, 'memory.update', 'memory_entries', v_entry.id, coalesce(p_audit, '{}'::jsonb));

  if v_new_client_id is distinct from v_entry.client_id then
    perform public.log_activity(p_actor, 'memory.link', 'memory_entries', v_entry.id,
      jsonb_build_object('entry_name', v_name, 'field', 'client_id', 'old', v_entry.client_id::text, 'new', v_new_client_id::text));
  end if;
  if v_new_deal_id is distinct from v_entry.deal_id then
    perform public.log_activity(p_actor, 'memory.link', 'memory_entries', v_entry.id,
      jsonb_build_object('entry_name', v_name, 'field', 'deal_id', 'old', v_entry.deal_id::text, 'new', v_new_deal_id::text));
  end if;

  return jsonb_build_object('id', v_entry.id, 'name', v_name, 'version_no', v_version, 'prior_updated_at', v_entry.updated_at);
end $$;

-- ── A4. client_360 — the payoff query. SERVICE-ROLE-ONLY (Aegis blocker 2, resolved r2): empty
--    search_path, fully qualified, execute revoked from public/anon/authenticated, granted only to
--    service_role. Exposed to humans ONLY via functions/api/client-360.ts (requireMember() gate). ────
create or replace function public.client_360(p_client_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_client jsonb;
begin
  if p_client_id is null then raise exception 'client_360: p_client_id is required'; end if;
  select to_jsonb(c) into v_client from public.clients c where c.id = p_client_id;
  if v_client is null then raise exception 'client_360: client % not found', p_client_id; end if;

  return jsonb_build_object(
    'client', v_client,
    'contacts', coalesce((
      select jsonb_agg(to_jsonb(ct) order by ct.name)
      from public.contacts ct where ct.client_id = p_client_id
    ), '[]'::jsonb),
    'deals', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.created_at desc)
      from public.deals d where d.client_id = p_client_id
    ), '[]'::jsonb),
    'memories', coalesce((
      select jsonb_agg(jsonb_build_object('name', m.name, 'title', m.title, 'kind', m.kind, 'updated_at', m.updated_at) order by m.updated_at desc)
      from public.memory_entries m
      where m.client_id = p_client_id
         or m.deal_id in (select id from public.deals where client_id = p_client_id)
    ), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object('id', doc.id, 'title', doc.title, 'doc_type', doc.doc_type, 'created_at', doc.created_at) order by doc.created_at desc)
      from public.documents doc
      where doc.client_id = p_client_id
         or doc.deal_id in (select id from public.deals where client_id = p_client_id)
    ), '[]'::jsonb),
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'action', a.action, 'entity_type', a.entity_type, 'entity_id', a.entity_id, 'detail', a.detail, 'created_at', a.created_at) order by a.created_at desc)
      from (
        select * from public.activity_log
        where (entity_type = 'clients' and entity_id = p_client_id)
           or (entity_type = 'deals' and entity_id in (select id from public.deals where client_id = p_client_id))
           or (entity_type = 'contacts' and entity_id in (select id from public.contacts where client_id = p_client_id))
        order by created_at desc
        limit 20
      ) a
    ), '[]'::jsonb)
  );
end $$;

revoke execute on function public.ingest_memory_entry(jsonb) from public, anon, authenticated;
revoke execute on function public.update_memory(jsonb, uuid, jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function public.client_360(uuid) from public, anon, authenticated;
grant  execute on function public.ingest_memory_entry(jsonb) to service_role;
grant  execute on function public.update_memory(jsonb, uuid, jsonb, timestamptz) to service_role;
grant  execute on function public.client_360(uuid) to service_role;

-- ═══════════════════════════════════ PART B — P2-CRM ═══════════════════════════════════════════════

-- ── B1. lead-gen-grade fields ────────────────────────────────────────────────────────────────────────
alter table public.clients
  add column if not exists industry text,
  add column if not exists website  text,
  add column if not exists source   text,
  add column if not exists status   text not null default 'prospect';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'clients_source_chk' and conrelid = 'public.clients'::regclass) then
    alter table public.clients add constraint clients_source_chk check (source is null or source in ('referral','inbound','outbound','event','other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'clients_status_chk' and conrelid = 'public.clients'::regclass) then
    alter table public.clients add constraint clients_status_chk check (status in ('prospect','active','dormant','lost'));
  end if;
end $$;

alter table public.contacts
  add column if not exists phone    text,
  add column if not exists linkedin text,
  add column if not exists title    text;

alter table public.deals
  add column if not exists next_action    text,
  add column if not exists follow_up_date date,
  add column if not exists expected_close date,
  add column if not exists updated_at     timestamptz not null default now();
drop trigger if exists trg_deals_updated_at on public.deals;
create trigger trg_deals_updated_at before update on public.deals
  for each row execute function public.set_updated_at();

-- ── B2. upsert_client — PATCH-safe (0016 pattern), extended with industry/website/source/status. ─────
create or replace function public.upsert_client(p_payload jsonb, p_actor uuid, p_audit jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id       uuid := nullif(p_payload->>'id','')::uuid;
  v_name     text := p_payload->>'name';
  v_source   text := p_payload->>'source';
  v_status   text := p_payload->>'status';
begin
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'upsert_client: actor must be an active team member';
  end if;
  if exists (select 1 from jsonb_object_keys(p_payload) k where k not in ('id','name','notes','industry','website','source','status')) then
    raise exception 'upsert_client: unexpected key in payload';
  end if;
  if p_payload ? 'name' and (jsonb_typeof(p_payload->'name') is distinct from 'string' or btrim(coalesce(v_name,'')) = '' or length(v_name) > 200) then
    raise exception 'upsert_client: name required (<=200 chars)';
  end if;
  if p_payload ? 'notes' and jsonb_typeof(p_payload->'notes') not in ('string','null') then raise exception 'upsert_client: notes must be a string'; end if;
  if (p_payload->>'notes') is not null and length(p_payload->>'notes') > 4000 then raise exception 'upsert_client: notes too long (<=4000)'; end if;
  if p_payload ? 'industry' and jsonb_typeof(p_payload->'industry') not in ('string','null') then raise exception 'upsert_client: industry must be a string'; end if;
  if (p_payload->>'industry') is not null and length(p_payload->>'industry') > 200 then raise exception 'upsert_client: industry too long (<=200)'; end if;
  if p_payload ? 'website' and jsonb_typeof(p_payload->'website') not in ('string','null') then raise exception 'upsert_client: website must be a string'; end if;
  if (p_payload->>'website') is not null and length(p_payload->>'website') > 300 then raise exception 'upsert_client: website too long (<=300)'; end if;
  if p_payload ? 'source' and v_source is not null and v_source not in ('referral','inbound','outbound','event','other') then raise exception 'upsert_client: bad source %', v_source; end if;
  if p_payload ? 'status' and (v_status is null or v_status not in ('prospect','active','dormant','lost')) then raise exception 'upsert_client: bad status %', v_status; end if;

  if v_id is null then
    if not (p_payload ? 'name') or btrim(coalesce(v_name,'')) = '' then raise exception 'upsert_client: name required'; end if;
    insert into public.clients (name, notes, industry, website, source, status)
      values (btrim(v_name), p_payload->>'notes', p_payload->>'industry', p_payload->>'website', v_source, coalesce(v_status, 'prospect'))
      returning id into v_id;
  else
    update public.clients set
      name     = case when p_payload ? 'name'     then btrim(v_name)          else name     end,
      notes    = case when p_payload ? 'notes'    then p_payload->>'notes'    else notes    end,
      industry = case when p_payload ? 'industry' then p_payload->>'industry' else industry end,
      website  = case when p_payload ? 'website'  then p_payload->>'website'  else website  end,
      source   = case when p_payload ? 'source'   then v_source               else source   end,
      status   = case when p_payload ? 'status'   then v_status               else status   end
      where id = v_id;
    if not found then raise exception 'upsert_client: client % not found', v_id; end if;
  end if;
  perform public.log_activity(p_actor, 'crm.client_save', 'clients', v_id, coalesce(p_audit,'{}'::jsonb));
  return v_id;
end $$;

-- ── B3. upsert_deal — PATCH-safe, extended with next_action/follow_up_date/expected_close. ───────────
create or replace function public.upsert_deal(p_payload jsonb, p_actor uuid, p_audit jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id        uuid := nullif(p_payload->>'id','')::uuid;
  v_client_id uuid := nullif(p_payload->>'client_id','')::uuid;
  v_owner_id  uuid := nullif(p_payload->>'owner_id','')::uuid;
  v_title     text := p_payload->>'title';
  v_stage     text := p_payload->>'stage';
  v_amount    numeric;
  v_follow_up date;
  v_expected_close date;
begin
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'upsert_deal: actor must be an active team member';
  end if;
  if exists (select 1 from jsonb_object_keys(p_payload) k where k not in ('id','client_id','title','stage','amount','currency','owner_id','notes','next_action','follow_up_date','expected_close')) then
    raise exception 'upsert_deal: unexpected key in payload';
  end if;
  if p_payload ? 'title' and (jsonb_typeof(p_payload->'title') is distinct from 'string' or btrim(coalesce(v_title,'')) = '' or length(v_title) > 200) then raise exception 'upsert_deal: title required (<=200 chars)'; end if;
  if p_payload ? 'stage' and (v_stage is null or v_stage not in ('lead','qualified','proposal','negotiation','won','lost')) then raise exception 'upsert_deal: bad stage %', v_stage; end if;
  if p_payload ? 'currency' and length(coalesce(nullif(p_payload->>'currency',''),'USD')) > 10 then raise exception 'upsert_deal: bad currency'; end if;
  if p_payload ? 'notes' and jsonb_typeof(p_payload->'notes') not in ('string','null') then raise exception 'upsert_deal: notes must be a string'; end if;
  if p_payload ? 'amount' and jsonb_typeof(p_payload->'amount') not in ('number','null') then raise exception 'upsert_deal: amount must be a number'; end if;
  if jsonb_typeof(p_payload->'amount') = 'number' then
    v_amount := (p_payload->>'amount')::numeric;
    if v_amount < 0 or v_amount > 1e12 then raise exception 'upsert_deal: amount out of range'; end if;
  end if;
  if p_payload ? 'next_action' and jsonb_typeof(p_payload->'next_action') not in ('string','null') then raise exception 'upsert_deal: next_action must be a string'; end if;
  if (p_payload->>'next_action') is not null and length(p_payload->>'next_action') > 500 then raise exception 'upsert_deal: next_action too long (<=500)'; end if;
  if p_payload ? 'follow_up_date' and jsonb_typeof(p_payload->'follow_up_date') not in ('string','null') then raise exception 'upsert_deal: follow_up_date must be a date string'; end if;
  if p_payload ? 'expected_close' and jsonb_typeof(p_payload->'expected_close') not in ('string','null') then raise exception 'upsert_deal: expected_close must be a date string'; end if;
  begin
    v_follow_up := nullif(p_payload->>'follow_up_date','')::date;
    v_expected_close := nullif(p_payload->>'expected_close','')::date;
  exception when others then
    raise exception 'upsert_deal: follow_up_date/expected_close must be a valid date (YYYY-MM-DD)';
  end;
  if v_client_id is not null and not exists (select 1 from public.clients where id = v_client_id) then raise exception 'upsert_deal: client % not found', v_client_id; end if;
  if v_owner_id is not null and not exists (select 1 from public.team_members where id = v_owner_id and active) then raise exception 'upsert_deal: owner must be an active team member'; end if;

  if v_id is null then
    if not (p_payload ? 'title') or btrim(coalesce(v_title,'')) = '' then raise exception 'upsert_deal: title required'; end if;
    if not (p_payload ? 'stage') then raise exception 'upsert_deal: stage required'; end if;
    insert into public.deals (client_id, title, stage, amount, currency, owner_id, notes, next_action, follow_up_date, expected_close)
      values (v_client_id, btrim(v_title), v_stage::public.deal_stage, v_amount,
              coalesce(nullif(p_payload->>'currency',''),'USD'), v_owner_id, p_payload->>'notes',
              p_payload->>'next_action', v_follow_up, v_expected_close)
      returning id into v_id;
  else
    update public.deals set
      client_id       = case when p_payload ? 'client_id'       then v_client_id                                       else client_id       end,
      title           = case when p_payload ? 'title'           then btrim(v_title)                                    else title           end,
      stage           = case when p_payload ? 'stage'           then v_stage::public.deal_stage                        else stage           end,
      amount          = case when p_payload ? 'amount'          then v_amount                                          else amount          end,
      currency        = case when p_payload ? 'currency'        then coalesce(nullif(p_payload->>'currency',''),'USD') else currency        end,
      owner_id        = case when p_payload ? 'owner_id'        then v_owner_id                                        else owner_id        end,
      notes           = case when p_payload ? 'notes'           then p_payload->>'notes'                               else notes           end,
      next_action     = case when p_payload ? 'next_action'     then p_payload->>'next_action'                         else next_action     end,
      follow_up_date  = case when p_payload ? 'follow_up_date'  then v_follow_up                                       else follow_up_date  end,
      expected_close  = case when p_payload ? 'expected_close'  then v_expected_close                                  else expected_close  end
      where id = v_id;
    if not found then raise exception 'upsert_deal: deal % not found', v_id; end if;
  end if;
  perform public.log_activity(p_actor, 'crm.deal_save', 'deals', v_id, coalesce(p_audit,'{}'::jsonb));
  return v_id;
end $$;

-- ── B4. upsert_contact — PATCH-safe, extended with phone/linkedin/title. ──────────────────────────────
create or replace function public.upsert_contact(p_payload jsonb, p_actor uuid, p_audit jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id        uuid := nullif(p_payload->>'id','')::uuid;
  v_client_id uuid := nullif(p_payload->>'client_id','')::uuid;
  v_name      text := p_payload->>'name';
begin
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'upsert_contact: actor must be an active team member';
  end if;
  if exists (select 1 from jsonb_object_keys(p_payload) k where k not in ('id','client_id','name','email','role','phone','linkedin','title')) then
    raise exception 'upsert_contact: unexpected key in payload';
  end if;
  if p_payload ? 'name' and (jsonb_typeof(p_payload->'name') is distinct from 'string' or btrim(coalesce(v_name,'')) = '' or length(v_name) > 200) then
    raise exception 'upsert_contact: name required (<=200 chars)';
  end if;
  if p_payload ? 'email' and jsonb_typeof(p_payload->'email') not in ('string','null') then raise exception 'upsert_contact: email must be a string'; end if;
  if (p_payload->>'email') is not null and length(p_payload->>'email') > 200 then raise exception 'upsert_contact: email too long (<=200)'; end if;
  if p_payload ? 'role' and jsonb_typeof(p_payload->'role') not in ('string','null') then raise exception 'upsert_contact: role must be a string'; end if;
  if (p_payload->>'role') is not null and length(p_payload->>'role') > 120 then raise exception 'upsert_contact: role too long (<=120)'; end if;
  if p_payload ? 'phone' and jsonb_typeof(p_payload->'phone') not in ('string','null') then raise exception 'upsert_contact: phone must be a string'; end if;
  if (p_payload->>'phone') is not null and length(p_payload->>'phone') > 40 then raise exception 'upsert_contact: phone too long (<=40)'; end if;
  if p_payload ? 'linkedin' and jsonb_typeof(p_payload->'linkedin') not in ('string','null') then raise exception 'upsert_contact: linkedin must be a string'; end if;
  if (p_payload->>'linkedin') is not null and length(p_payload->>'linkedin') > 300 then raise exception 'upsert_contact: linkedin too long (<=300)'; end if;
  if p_payload ? 'title' and jsonb_typeof(p_payload->'title') not in ('string','null') then raise exception 'upsert_contact: title must be a string'; end if;
  if (p_payload->>'title') is not null and length(p_payload->>'title') > 150 then raise exception 'upsert_contact: title too long (<=150)'; end if;
  if v_client_id is not null and not exists (select 1 from public.clients where id = v_client_id) then raise exception 'upsert_contact: client % not found', v_client_id; end if;

  if v_id is null then
    if not (p_payload ? 'name') or btrim(coalesce(v_name,'')) = '' then raise exception 'upsert_contact: name required'; end if;
    if v_client_id is null then raise exception 'upsert_contact: client_id required'; end if;
    insert into public.contacts (client_id, name, email, role, phone, linkedin, title)
      values (v_client_id, btrim(v_name), p_payload->>'email', p_payload->>'role', p_payload->>'phone', p_payload->>'linkedin', p_payload->>'title')
      returning id into v_id;
  else
    update public.contacts set
      client_id = case when p_payload ? 'client_id' then v_client_id         else client_id end,
      name      = case when p_payload ? 'name'      then btrim(v_name)       else name      end,
      email     = case when p_payload ? 'email'     then p_payload->>'email' else email     end,
      role      = case when p_payload ? 'role'      then p_payload->>'role'  else role      end,
      phone     = case when p_payload ? 'phone'     then p_payload->>'phone'    else phone     end,
      linkedin  = case when p_payload ? 'linkedin'  then p_payload->>'linkedin' else linkedin  end,
      title     = case when p_payload ? 'title'     then p_payload->>'title'    else title     end
      where id = v_id;
    if not found then raise exception 'upsert_contact: contact % not found', v_id; end if;
  end if;
  perform public.log_activity(p_actor, 'crm.contact_save', 'contacts', v_id, coalesce(p_audit,'{}'::jsonb));
  return v_id;
end $$;

revoke execute on function public.upsert_client(jsonb, uuid, jsonb)  from public, anon, authenticated;
revoke execute on function public.upsert_deal(jsonb, uuid, jsonb)    from public, anon, authenticated;
revoke execute on function public.upsert_contact(jsonb, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.upsert_client(jsonb, uuid, jsonb)  to service_role;
grant  execute on function public.upsert_deal(jsonb, uuid, jsonb)    to service_role;
grant  execute on function public.upsert_contact(jsonb, uuid, jsonb) to service_role;

-- ── B5. log_activity — minimal, exact-string-matched null-actor carve-out (see file header note #1).
--    Every OTHER caller/action keeps the original fail-closed "actor must be an active team member"
--    behavior verbatim; only p_action = 'crm.stale_deals' may pass a null actor. ──────────────────────
create or replace function public.log_activity(p_actor uuid, p_action text, p_entity_type text, p_entity_id uuid, p_detail jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  c_secret_re constant text := '(sk_(live|test)_[A-Za-z0-9]|sbp_[A-Za-z0-9]{20}|sb_(secret|publishable)_|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{30}|-----BEGIN [A-Z ]*PRIVATE KEY-----)';
begin
  if p_actor is null then
    if p_action is distinct from 'crm.stale_deals' then
      raise exception 'log_activity: actor must be an active team member';
    end if;
  elsif not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'log_activity: actor must be an active team member';
  end if;
  if p_action is null or length(p_action) > 200 or p_action !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' then
    raise exception 'log_activity: action must match ^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$ and be <=200 chars';
  end if;
  if p_entity_type is not null then
    if length(p_entity_type) > 100 then raise exception 'log_activity: entity_type too long'; end if;
    if p_entity_type ~* c_secret_re then
      raise exception 'log_activity: entity_type appears to contain a secret';
    end if;
  end if;
  if p_detail is null or jsonb_typeof(p_detail) <> 'object' then raise exception 'log_activity: detail must be a JSON object'; end if;
  if octet_length(p_detail::text) > 4096 then raise exception 'log_activity: detail exceeds 4096 bytes'; end if;
  if (select count(*) from jsonb_object_keys(p_detail)) > 30 then raise exception 'log_activity: detail has too many keys (>30)'; end if;
  if exists (select 1 from jsonb_each(p_detail) e where jsonb_typeof(e.value) in ('object','array')) then
    raise exception 'log_activity: detail must be flat (no nested objects/arrays)';
  end if;
  if exists (select 1 from jsonb_each(p_detail) e where jsonb_typeof(e.value) = 'string' and length(e.value #>> '{}') > 1000) then
    raise exception 'log_activity: detail string value too long (>1000)';
  end if;
  if exists (
    select 1 from jsonb_each(p_detail) e
    where e.key ~* c_secret_re
       or (jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') ~* c_secret_re)
  ) then
    raise exception 'log_activity: detail appears to contain a secret';
  end if;
  insert into public.activity_log (actor_id, action, entity_type, entity_id, detail)
    values (p_actor, p_action, p_entity_type, p_entity_id, p_detail)
    returning id into v_id;
  return v_id;
end $$;

-- ── B6. stale-deal digest. pg_cron confirmed available on this plan (list_extensions, 2026-07-02;
--    installed_version was null, default_version 1.6.4 — enabling now). Open-stage set derived from
--    the REAL deal_stage enum (0001_init.sql): lead/qualified/proposal/negotiation are open,
--    won/lost are terminal — not invented. Stale predicate matches the REAL convention upsert_deal's
--    own log_activity call uses: entity_type = 'deals' (plural, verified above), entity_id = deals.id.
create extension if not exists pg_cron;

create or replace function public.run_stale_deals_digest()
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_digest_date date := current_date;
  v_deals jsonb;
  v_count int;
  v_deals_json text;
begin
  -- same-day idempotency: a digest for today already exists -> no-op (Aegis-required, no duplicates)
  if exists (
    select 1 from public.activity_log
    where action = 'crm.stale_deals' and detail->>'digest_date' = v_digest_date::text
  ) then
    return;
  end if;

  select jsonb_agg(jsonb_build_object('title', d.title, 'days_stale', greatest(0, extract(day from now() - coalesce(la.last_activity, d.created_at))::int)) order by coalesce(la.last_activity, d.created_at) asc),
         count(*)
  into v_deals, v_count
  from public.deals d
  left join lateral (
    select max(created_at) as last_activity from public.activity_log where entity_type = 'deals' and entity_id = d.id
  ) la on true
  where d.stage in ('lead','qualified','proposal','negotiation')
    and (la.last_activity is null or la.last_activity < now() - interval '14 days')
    and (d.follow_up_date is null or d.follow_up_date < current_date);

  v_count := coalesce(v_count, 0);
  -- encode the deal list as a JSON STRING value (not a nested array) to satisfy log_activity's flat-
  -- detail constraint unchanged (see file header note #2); cap to fit the 1000-char string bound.
  v_deals_json := coalesce(v_deals::text, '[]');
  if length(v_deals_json) > 1000 then
    v_deals_json := left(v_deals_json, 950) || '...(truncated)]';
  end if;

  perform public.log_activity(null, 'crm.stale_deals', null, null,
    jsonb_build_object('source', 'cron', 'digest_date', v_digest_date::text, 'stale_count', v_count, 'deals_json', v_deals_json));
end $$;

revoke execute on function public.run_stale_deals_digest() from public, anon, authenticated;
grant  execute on function public.run_stale_deals_digest() to service_role;

-- stable job name, re-runnable: unschedule-if-exists then reschedule (07:00 ET = 12:00 UTC).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'mnemosyne_stale_deals_daily') then
    perform cron.unschedule('mnemosyne_stale_deals_daily');
  end if;
end $$;
select cron.schedule('mnemosyne_stale_deals_daily', '0 12 * * *', 'select public.run_stale_deals_digest();');

-- ═══════════════════════════════════ PART C — P1-HYBRID ════════════════════════════════════════════

-- ── C1. FTS generated column + GIN index. Table is small (146 rows at build time, 2026-07-02) — a
--    STORED generated column rewrite is trivial here; a trigger-maintained column is the alternative
--    if this table ever grows large (documented per Aegis non-blocking note, not needed now). ────────
alter table public.memory_entries
  add column if not exists fts tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(name, '') || ' ' || coalesce(body, ''))
  ) stored;
create index if not exists memory_entries_fts_idx on public.memory_entries using gin (fts);

-- ── C2. recall_memory_hybrid — a NEW function (Aegis blocker 1, resolved r2). Does NOT replace,
--    overload, or wrap recall_memory(vector,int) — that function is completely untouched by this
--    migration; deployed old code keeps calling it, unaffected, until the caller-switch code push.
--    Fuses vector top-K + FTS top-K via reciprocal-rank fusion (k=60), applies optional kind/project/
--    client/deal filters BEFORE ranking (so ranks are computed within the filtered scope, not after),
--    then a mild recency boost. p_query is the RAW text (the missing piece Aegis caught — embeddings
--    can't be un-embedded back into searchable text). ──────────────────────────────────────────────
create or replace function public.recall_memory_hybrid(
  p_query text,
  p_embedding public.vector(768),
  p_match_count int default 8,
  p_kind text default null,
  p_project_id uuid default null,
  p_client_id uuid default null,
  p_deal_id uuid default null
)
returns table (
  name text, title text, kind public.memory_kind, source_path text,
  similarity double precision, updated_at timestamptz, matched_via text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_match_count int := least(greatest(coalesce(p_match_count, 8), 1), 50);
  v_tsquery tsquery;
begin
  if p_query is not null and btrim(p_query) <> '' then
    begin
      v_tsquery := websearch_to_tsquery('english', p_query);
    exception when others then
      v_tsquery := null;   -- malformed query text -> fts arm simply contributes nothing, vector arm still works
    end;
  end if;

  return query
  with scoped as (
    select e.id, e.name, e.title, e.kind, e.source_path, e.updated_at, e.embedding, e.fts
    from public.memory_entries e
    where (p_kind is null or e.kind::text = p_kind)
      and (p_project_id is null or e.project_id = p_project_id)
      and (p_client_id is null or e.client_id = p_client_id)
      and (p_deal_id is null or e.deal_id = p_deal_id)
  ),
  vec_hits as (
    select s.name, s.title, s.kind, s.source_path, s.updated_at,
           1 - (s.embedding OPERATOR(public.<=>) p_embedding) as vscore
    from scoped s where s.embedding is not null
    union all
    select s.name, s.title, s.kind, s.source_path, s.updated_at,
           1 - (c.embedding OPERATOR(public.<=>) p_embedding) as vscore
    from public.memory_chunks c
    join scoped s on s.id = c.memory_entry_id
  ),
  vec_best as (
    select distinct on (name) name, title, kind, source_path, updated_at, vscore
    from vec_hits
    order by name, vscore desc
  ),
  vec_ranked as (
    select *, row_number() over (order by vscore desc) as vrank from vec_best
  ),
  fts_hits as (
    select s.name, s.title, s.kind, s.source_path, s.updated_at,
           ts_rank(s.fts, v_tsquery) as fscore
    from scoped s
    where v_tsquery is not null and s.fts @@ v_tsquery
  ),
  fts_ranked as (
    select *, row_number() over (order by fscore desc) as frank from fts_hits
  ),
  fused as (
    select
      coalesce(v.name, f.name) as name,
      coalesce(v.title, f.title) as title,
      coalesce(v.kind, f.kind) as kind,
      coalesce(v.source_path, f.source_path) as source_path,
      coalesce(v.updated_at, f.updated_at) as updated_at,
      (coalesce(1.0 / (60 + v.vrank), 0) + coalesce(1.0 / (60 + f.frank), 0)) as rrf,
      case when v.name is not null and f.name is not null then 'both'
           when v.name is not null then 'vector'
           else 'fts' end as matched_via
    from vec_ranked v
    full outer join fts_ranked f on v.name = f.name
  )
  select
    fused.name, fused.title, fused.kind, fused.source_path,
    -- mild recency boost: score * (1 + 0.1 * exp(-age_days/90)) — tuned to nudge, not dominate, RRF
    (fused.rrf * (1 + 0.1 * exp(-(extract(epoch from (now() - fused.updated_at)) / 86400.0) / 90.0))) as similarity,
    fused.updated_at, fused.matched_via
  from fused
  order by similarity desc
  limit v_match_count;
end $$;

revoke execute on function public.recall_memory_hybrid(text, public.vector, int, text, uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.recall_memory_hybrid(text, public.vector, int, text, uuid, uuid, uuid) to service_role;
