-- Mnemosyne — 0033: Unit S SEC hardening (thread 0037, 2026-07-10).
-- HELD UNAPPLIED until Atlas/Fable QC + Jesse apply-go.
--
-- Part 1: DB-level tenant backstop for /api/agent-context reads.
-- Part 2: honest hybrid recall fields: score = fused rank score, similarity = true vector cosine.

-- ── S2. get_agent_client_context: service-role-only tenant-scoped read backstop ────────────────
create or replace function public.get_agent_client_context(
  p_client_slug text,
  p_wanted_tags text[],
  p_limit int default 20
)
returns table (body text, tags text[], updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
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
    select 1
    from public.agent_clients c
    where c.client_slug = p_client_slug
      and c.is_active
  ) then
    raise exception 'get_agent_client_context: unknown or inactive client_slug';
  end if;

  return query
  select e.body, e.tags, e.updated_at
  from public.memory_entries e
  where e.tags @> array['client:' || p_client_slug]
    and e.tags && p_wanted_tags
  order by e.updated_at desc
  limit v_limit;
end $$;

revoke execute on function public.get_agent_client_context(text, text[], int) from public, anon, authenticated;
grant  execute on function public.get_agent_client_context(text, text[], int) to service_role;

-- ── S3. recall_memory_hybrid: split fused rank score from true vector similarity ───────────────
-- Return shape changes, so CREATE OR REPLACE would raise 42P13. Drop/recreate in this migration.
drop function if exists public.recall_memory_hybrid(text, public.vector, int, text, uuid, uuid, uuid);

create function public.recall_memory_hybrid(
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
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
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
      v.vscore as vscore,
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
    (fused.rrf * (1 + 0.1 * exp(-(extract(epoch from (now() - fused.updated_at)) / 86400.0) / 90.0)))::double precision as score,
    fused.vscore::double precision as similarity,
    fused.updated_at, fused.matched_via
  from fused
  order by score desc
  limit v_match_count;
end $$;

revoke execute on function public.recall_memory_hybrid(text, public.vector, int, text, uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.recall_memory_hybrid(text, public.vector, int, text, uuid, uuid, uuid) to service_role;
