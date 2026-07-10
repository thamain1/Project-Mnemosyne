-- Mnemosyne - 0034: Unit L Librarian v1 (thread 0037, 2026-07-10).
-- HELD UNAPPLIED until Atlas/Fable QC + Jesse apply-go.
--
-- Part 1: lifecycle state, recall-stat side-table, curation RPCs, archived filters.
-- Part 2: passive recall counters inside the two service-role read RPCs.
-- Part 3: deterministic daily librarian digest (report-only; never mutates memories).
-- Part 4: narrow version reader for the scanned app-layer revert path.

-- -- L1. Lifecycle state + recall statistics -------------------------------------------------
alter table public.memory_entries
  add column if not exists verified_at   timestamptz,
  add column if not exists archived      boolean not null default false,
  add column if not exists superseded_by uuid references public.memory_entries(id);

-- Preserve the historical updated_at values during this one-shot freshness backfill. A plain
-- UPDATE would fire trg_memory_entries_updated_at and make every memory look freshly edited.
alter table public.memory_entries disable trigger trg_memory_entries_updated_at;
update public.memory_entries set verified_at = updated_at where verified_at is null;
alter table public.memory_entries enable trigger trg_memory_entries_updated_at;

create table if not exists public.memory_recall_stats (
  entry_id         uuid primary key references public.memory_entries(id) on delete cascade,
  recall_count     int not null default 0,
  last_recalled_at timestamptz
);

alter table public.memory_recall_stats enable row level security;
revoke all on public.memory_recall_stats from anon;
revoke all on public.memory_recall_stats from authenticated;
grant select on public.memory_recall_stats to authenticated;

drop policy if exists memory_recall_stats_select on public.memory_recall_stats;
create policy memory_recall_stats_select on public.memory_recall_stats
  for select to authenticated using (public.is_team_member());

-- Work-order signature correction: PostgreSQL requires every input after a defaulted input to
-- have a default too. Keep the ordered API and default p_reason to null, then require it here.
create or replace function public.archive_memory(
  p_actor uuid,
  p_name text,
  p_archived boolean,
  p_superseded_by uuid default null,
  p_reason text default null
)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entry public.memory_entries%rowtype;
begin
  if p_actor is null or not exists (
    select 1 from public.team_members where id = p_actor and active
  ) then
    raise exception 'archive_memory: actor must be an active team member';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'archive_memory: name is required';
  end if;
  if p_archived is null then
    raise exception 'archive_memory: archived is required';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'archive_memory: reason is required';
  end if;
  if length(p_reason) > 1000 then
    raise exception 'archive_memory: reason too long (>1000)';
  end if;

  select * into v_entry from public.memory_entries where name = p_name for update;
  if not found then
    raise exception 'archive_memory: no entry named "%"', p_name;
  end if;

  if p_superseded_by = v_entry.id then
    raise exception 'archive_memory: an entry cannot supersede itself';
  end if;
  if p_superseded_by is not null and not exists (
    select 1 from public.memory_entries where id = p_superseded_by
  ) then
    raise exception 'archive_memory: superseding entry % not found', p_superseded_by;
  end if;

  update public.memory_entries
  set archived = p_archived,
      superseded_by = p_superseded_by
  where id = v_entry.id;

  perform public.log_activity(
    p_actor,
    case when p_archived then 'memory.archive' else 'memory.unarchive' end,
    'memory_entries',
    v_entry.id,
    jsonb_build_object(
      'name', v_entry.name,
      'reason', btrim(p_reason),
      'superseded_by', p_superseded_by::text
    )
  );
end $$;

create or replace function public.confirm_memory_verified(p_actor uuid, p_name text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entry public.memory_entries%rowtype;
begin
  if p_actor is null or not exists (
    select 1 from public.team_members where id = p_actor and active
  ) then
    raise exception 'confirm_memory_verified: actor must be an active team member';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'confirm_memory_verified: name is required';
  end if;

  select * into v_entry from public.memory_entries where name = p_name for update;
  if not found then
    raise exception 'confirm_memory_verified: no entry named "%"', p_name;
  end if;

  -- Deliberate: human verification is a real freshness signal, so the updated_at trigger should fire.
  update public.memory_entries set verified_at = now() where id = v_entry.id;
  perform public.log_activity(
    p_actor, 'memory.verify', 'memory_entries', v_entry.id,
    jsonb_build_object('name', v_entry.name)
  );
end $$;

revoke execute on function public.archive_memory(uuid, text, boolean, uuid, text) from public, anon, authenticated;
revoke execute on function public.confirm_memory_verified(uuid, text) from public, anon, authenticated;
grant execute on function public.archive_memory(uuid, text, boolean, uuid, text) to service_role;
grant execute on function public.confirm_memory_verified(uuid, text) to service_role;

-- client_360 return type is unchanged; only hide archived memories from its memory arm.
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
      where not m.archived
        and (m.client_id = p_client_id
          or m.deal_id in (select id from public.deals where client_id = p_client_id))
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

-- -- L2. Passive recall counters without touching memory_entries.updated_at -------------------
create or replace function public.get_agent_client_context(
  p_client_slug text,
  p_wanted_tags text[],
  p_limit int default 20
)
returns table (body text, tags text[], updated_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 20);
  v_tag_count int := coalesce(cardinality(p_wanted_tags), 0);
begin
  if p_client_slug is null or btrim(p_client_slug) = '' or p_client_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'get_agent_client_context: bad client_slug';
  end if;
  if v_tag_count = 0 or v_tag_count > 21 then
    raise exception 'get_agent_client_context: wanted_tags must have 1-21 entries';
  end if;
  if exists (select 1 from unnest(p_wanted_tags) as t(tag) where t.tag is null or btrim(t.tag) = '') then
    raise exception 'get_agent_client_context: wanted_tags cannot contain null/empty entries';
  end if;
  if not exists (
    select 1 from public.agent_clients c where c.client_slug = p_client_slug and c.is_active
  ) then
    raise exception 'get_agent_client_context: unknown or inactive client_slug';
  end if;

  return query
  with final_results as materialized (
    select e.id, e.body, e.tags, e.updated_at
    from public.memory_entries e
    where e.tags @> array['client:' || p_client_slug]
      and e.tags && p_wanted_tags
      and not e.archived
    order by e.updated_at desc
    limit v_limit
  ),
  bump as (
    insert into public.memory_recall_stats (entry_id, recall_count, last_recalled_at)
    select fr.id, 1, now() from final_results fr
    on conflict (entry_id) do update
      set recall_count = public.memory_recall_stats.recall_count + 1,
          last_recalled_at = now()
    returning entry_id
  )
  select fr.body, fr.tags, fr.updated_at
  from final_results fr
  cross join (select count(*) from bump) applied
  order by fr.updated_at desc;
end $$;

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
  score double precision, similarity double precision, updated_at timestamptz, matched_via text
)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_match_count int := least(greatest(coalesce(p_match_count, 8), 1), 50);
  v_tsquery tsquery;
begin
  if p_query is not null and btrim(p_query) <> '' then
    begin
      v_tsquery := websearch_to_tsquery('english', p_query);
    exception when others then
      v_tsquery := null;
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
      and not e.archived
  ),
  vec_hits as (
    select s.id, s.name, s.title, s.kind, s.source_path, s.updated_at,
           1 - (s.embedding OPERATOR(public.<=>) p_embedding) as vscore
    from scoped s where s.embedding is not null
    union all
    select s.id, s.name, s.title, s.kind, s.source_path, s.updated_at,
           1 - (c.embedding OPERATOR(public.<=>) p_embedding) as vscore
    from public.memory_chunks c
    join scoped s on s.id = c.memory_entry_id
  ),
  vec_best as (
    select distinct on (name) id, name, title, kind, source_path, updated_at, vscore
    from vec_hits
    order by name, vscore desc
  ),
  vec_ranked as (
    select *, row_number() over (order by vscore desc) as vrank from vec_best
  ),
  fts_hits as (
    select s.id, s.name, s.title, s.kind, s.source_path, s.updated_at,
           ts_rank(s.fts, v_tsquery) as fscore
    from scoped s
    where v_tsquery is not null and s.fts @@ v_tsquery
  ),
  fts_ranked as (
    select *, row_number() over (order by fscore desc) as frank from fts_hits
  ),
  fused as (
    select
      coalesce(v.id, f.id) as id,
      coalesce(v.name, f.name) as name,
      coalesce(v.title, f.title) as title,
      coalesce(v.kind, f.kind) as kind,
      coalesce(v.source_path, f.source_path) as source_path,
      coalesce(v.updated_at, f.updated_at) as updated_at,
      v.vscore as vscore,
      (coalesce(1.0 / (60 + v.vrank), 0) + coalesce(1.0 / (60 + f.frank), 0)) as rrf,
      case when v.name is not null and f.name is not null then 'both'
           when v.name is not null then 'vector'
           else 'fts' end as matched_via
    from vec_ranked v
    full outer join fts_ranked f on v.name = f.name
  ),
  final_results as materialized (
    select
      fused.id, fused.name, fused.title, fused.kind, fused.source_path,
      (fused.rrf * (1 + 0.1 * exp(-(extract(epoch from (now() - fused.updated_at)) / 86400.0) / 90.0)))::double precision as score,
      fused.vscore::double precision as similarity,
      fused.updated_at, fused.matched_via
    from fused
    order by score desc
    limit v_match_count
  ),
  bump as (
    insert into public.memory_recall_stats (entry_id, recall_count, last_recalled_at)
    select fr.id, 1, now() from final_results fr
    on conflict (entry_id) do update
      set recall_count = public.memory_recall_stats.recall_count + 1,
          last_recalled_at = now()
    returning entry_id
  )
  select fr.name, fr.title, fr.kind, fr.source_path, fr.score, fr.similarity, fr.updated_at, fr.matched_via
  from final_results fr
  cross join (select count(*) from bump) applied
  order by fr.score desc;
end $$;

revoke execute on function public.get_agent_client_context(text, text[], int) from public, anon, authenticated;
revoke execute on function public.recall_memory_hybrid(text, public.vector, int, text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_agent_client_context(text, text[], int) to service_role;
grant execute on function public.recall_memory_hybrid(text, public.vector, int, text, uuid, uuid, uuid) to service_role;

-- -- L3. Deterministic, report-only librarian digest ------------------------------------------
-- Extend the exact null-system-actor carve-out for the second cron-owned action. All other
-- null-actor calls continue to fail closed, and the flat-detail/secret-scan checks are unchanged.
create or replace function public.log_activity(p_actor uuid, p_action text, p_entity_type text, p_entity_id uuid, p_detail jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  c_secret_re constant text := '(sk_(live|test)_[A-Za-z0-9]|sbp_[A-Za-z0-9]{20}|sb_(secret|publishable)_|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{30}|-----BEGIN [A-Z ]*PRIVATE KEY-----)';
begin
  if p_actor is null then
    if p_action not in ('crm.stale_deals', 'librarian.digest') then
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
    if p_entity_type ~* c_secret_re then raise exception 'log_activity: entity_type appears to contain a secret'; end if;
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

create or replace function public.run_memory_librarian()
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_digest_date date := current_date;
  v_stale jsonb := '[]'::jsonb;
  v_near_dups jsonb := '[]'::jsonb;
  v_dead_links jsonb := '[]'::jsonb;
  v_consolidation jsonb := '[]'::jsonb;
  v_stale_count int := 0;
  v_near_dups_count int := 0;
  v_dead_links_count int := 0;
  v_consolidation_count int := 0;
  c_default_stale constant interval := interval '6 months';
  c_lead_intel_stale constant interval := interval '2 months';
  c_near_dup_distance constant double precision := 0.10;
  c_json_text_cap constant int := 950;
begin
  if exists (
    select 1 from public.activity_log
    where action = 'librarian.digest' and detail->>'digest_date' = v_digest_date::text
  ) then
    return;
  end if;

  -- Tuning defaults: 6 months generally, 2 months for CRM-linked lead intel.
  select count(*) into v_stale_count
  from public.memory_entries e
  where not e.archived
    and (
      ((e.client_id is not null or e.deal_id is not null) and e.verified_at < now() - c_lead_intel_stale)
      or ((e.client_id is null and e.deal_id is null) and e.verified_at < now() - c_default_stale)
    );
  select coalesce(jsonb_agg(jsonb_build_object('name', q.name, 'verified_at', q.verified_at) order by q.verified_at), '[]'::jsonb)
  into v_stale
  from (
    select e.name, e.verified_at
    from public.memory_entries e
    where not e.archived
      and (
        ((e.client_id is not null or e.deal_id is not null) and e.verified_at < now() - c_lead_intel_stale)
        or ((e.client_id is null and e.deal_id is null) and e.verified_at < now() - c_default_stale)
      )
    order by e.verified_at asc
    limit 15
  ) q;

  -- Entry-level embeddings only. O(N^2) is trivial near 200 rows; add candidate blocking before
  -- this reaches thousands of embedded entries.
  select count(*) into v_near_dups_count
  from public.memory_entries a
  join public.memory_entries b on a.name < b.name
  where not a.archived and not b.archived
    and a.embedding is not null and b.embedding is not null
    and (a.embedding OPERATOR(public.<=>) b.embedding) < c_near_dup_distance;
  select coalesce(jsonb_agg(jsonb_build_object('a', q.a_name, 'b', q.b_name, 'similarity', q.similarity) order by q.distance), '[]'::jsonb)
  into v_near_dups
  from (
    select a.name as a_name, b.name as b_name,
           (a.embedding OPERATOR(public.<=>) b.embedding) as distance,
           round((1 - (a.embedding OPERATOR(public.<=>) b.embedding))::numeric, 6) as similarity
    from public.memory_entries a
    join public.memory_entries b on a.name < b.name
    where not a.archived and not b.archived
      and a.embedding is not null and b.embedding is not null
      and (a.embedding OPERATOR(public.<=>) b.embedding) < c_near_dup_distance
    order by distance asc, a.name, b.name
    limit 10
  ) q;

  select count(*) into v_dead_links_count
  from public.memory_entries e
  cross join lateral unnest(e.links) as l(target)
  where not exists (select 1 from public.memory_entries target where target.name = l.target);
  select coalesce(jsonb_agg(jsonb_build_object('source', q.source, 'target', q.target) order by q.source, q.target), '[]'::jsonb)
  into v_dead_links
  from (
    select e.name as source, l.target
    from public.memory_entries e
    cross join lateral unnest(e.links) as l(target)
    where not exists (select 1 from public.memory_entries target where target.name = l.target)
    order by e.name, l.target
    limit 15
  ) q;

  select count(*) into v_consolidation_count
  from (
    select tag
    from public.memory_entries e
    cross join lateral unnest(e.tags) as t(tag)
    where not e.archived
      and e.source_path like 'agent/%'
      and t.tag like 'client:%'
    group by tag
    having count(*) >= 3
  ) groups_to_consolidate;
  select coalesce(jsonb_agg(jsonb_build_object('tag', q.tag, 'count', q.entry_count) order by q.entry_count desc, q.tag), '[]'::jsonb)
  into v_consolidation
  from (
    select t.tag, count(*)::int as entry_count
    from public.memory_entries e
    cross join lateral unnest(e.tags) as t(tag)
    where not e.archived
      and e.source_path like 'agent/%'
      and t.tag like 'client:%'
    group by t.tag
    having count(*) >= 3
    order by entry_count desc, t.tag
    limit 15
  ) q;

  -- log_activity requires flat detail and <=1000 chars per string. Trim whole trailing elements so
  -- every encoded list remains valid JSON rather than slicing it into an invalid fragment.
  while length(v_stale::text) > c_json_text_cap and jsonb_array_length(v_stale) > 0 loop
    v_stale := v_stale - (jsonb_array_length(v_stale) - 1);
  end loop;
  while length(v_near_dups::text) > c_json_text_cap and jsonb_array_length(v_near_dups) > 0 loop
    v_near_dups := v_near_dups - (jsonb_array_length(v_near_dups) - 1);
  end loop;
  while length(v_dead_links::text) > c_json_text_cap and jsonb_array_length(v_dead_links) > 0 loop
    v_dead_links := v_dead_links - (jsonb_array_length(v_dead_links) - 1);
  end loop;
  while length(v_consolidation::text) > c_json_text_cap and jsonb_array_length(v_consolidation) > 0 loop
    v_consolidation := v_consolidation - (jsonb_array_length(v_consolidation) - 1);
  end loop;

  perform public.log_activity(null, 'librarian.digest', null, null, jsonb_build_object(
    'source', 'cron',
    'digest_date', v_digest_date::text,
    'stale_count', v_stale_count,
    'stale_json', v_stale::text,
    'near_dups_count', v_near_dups_count,
    'near_dups_json', v_near_dups::text,
    'dead_links_count', v_dead_links_count,
    'dead_links_json', v_dead_links::text,
    'consolidation_count', v_consolidation_count,
    'consolidation_json', v_consolidation::text
  ));
end $$;

revoke execute on function public.run_memory_librarian() from public, anon, authenticated;
grant execute on function public.run_memory_librarian() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'mnemosyne_memory_librarian_daily') then
    perform cron.unschedule('mnemosyne_memory_librarian_daily');
  end if;
end $$;
select cron.schedule('mnemosyne_memory_librarian_daily', '10 12 * * *', 'select public.run_memory_librarian();');

-- -- L5. Narrow version reader; body is secret-scanned in revert-core before embed or output ----
create or replace function public.get_memory_version(p_name text, p_version_no int)
returns table (
  id uuid,
  entry_id uuid,
  version_no int,
  name text,
  kind public.memory_kind,
  title text,
  body text,
  links text[],
  source_path text,
  sensitivity public.sensitivity_tier,
  edited_by uuid,
  change_reason text,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'get_memory_version: name is required';
  end if;
  if p_version_no is null or p_version_no < 1 then
    raise exception 'get_memory_version: version_no must be a positive integer';
  end if;
  if not exists (select 1 from public.memory_entries e where e.name = p_name) then
    raise exception 'get_memory_version: no entry named "%"', p_name;
  end if;

  return query
  select v.id, v.entry_id, v.version_no, v.name, v.kind, v.title, v.body, v.links,
         v.source_path, v.sensitivity, v.edited_by, v.change_reason, v.created_at
  from public.memory_versions v
  join public.memory_entries e on e.id = v.entry_id
  where e.name = p_name and v.version_no = p_version_no
  limit 1;

  if not found then
    raise exception 'get_memory_version: version % not found for "%"', p_version_no, p_name;
  end if;
end $$;

revoke execute on function public.get_memory_version(text, int) from public, anon, authenticated;
grant execute on function public.get_memory_version(text, int) to service_role;
