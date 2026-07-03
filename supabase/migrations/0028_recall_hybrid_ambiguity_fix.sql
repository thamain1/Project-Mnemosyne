-- Mnemosyne — 0028: fix plpgsql variable-capture ambiguity in recall_memory_hybrid (thread 0032
-- gate-run finding, 2026-07-03; applied same day via Management API). RETURNS TABLE creates OUT
-- variables (name/title/kind/...) that collide with CTE column references in the body —
-- 'distinct on (name)' raised 42702 on every call. Keyless tests cannot catch this (no live DB).
-- Fix: #variable_conflict use_column — every ambiguous reference in this body means the COLUMN.
-- NOTE: superseded same day by 0029 (adds a ::double precision cast the 42702 had been masking).

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
