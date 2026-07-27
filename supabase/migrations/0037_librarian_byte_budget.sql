-- Mnemosyne - 0037: librarian byte-budget fix (thread 0037, Aegis QC round 2, 2026-07-27).
-- HELD UNAPPLIED until QC + Jesse apply-go.
--
-- Number note: 0035 remains reserved for Unit R. This is migration 0037; do not confuse it with
-- THREAD 0037, which is the sprint these units belong to.
--
-- DEFECT (Aegis QC round 2, verdict STILL HOLD): 0036 defended a BYTE limit with a CHARACTER cap.
--
--   log_activity enforces TWO different limits in TWO different units (0034:364-372):
--     (a) per string value : length(e.value #>> '{}') > 1000        -- CHARACTERS
--     (b) whole detail     : octet_length(p_detail::text) > 4096    -- BYTES
--
--   0036's trim loops measured `length(v_*::text)` against an 820-CHARACTER cap and treated that as
--   protection for (b). For ASCII the two coincide, so every test passed. For multibyte they do not:
--     length(repeat('e-acute',820)) = 820 chars, octet_length = 1640 bytes
--   Four sections of 2-byte characters land near 6.5KB; 4-byte emoji exceed 13KB. Aegis measured a
--   12,377-byte outer detail while every inner string was under 820 characters, and reproduced a hard
--   failure on prod: `log_activity: detail exceeds 4096 bytes`. Escaping compounds it -- inner quotes
--   and backslashes are re-escaped when those JSON arrays are stored as outer string fields.
--
--   Reachable through the normal hosted `remember` path, not just direct SQL: extractLinks preserves
--   arbitrary link text (`remember-core.mjs:95`) and the write RPC type-checks link elements without
--   any charset or length restriction. One long non-ASCII [[link]] silently kills the daily digest
--   from that day on. The digest is report-only, so this denies the report rather than losing data --
--   but the report is the entirety of Unit L.
--
-- FIX -- measure each limit in its own unit, and for the byte limit measure the ACTUAL enforcement
-- surface rather than guessing another constant:
--
--   (a) A character trim per sample, capped at 990, still defends the per-string limit. A character
--       cap is the CORRECT instrument here because that limit is itself expressed in characters.
--   (b) The outer object is then assembled into v_detail and measured with octet_length(v_detail::text)
--       -- byte for byte, the same expression log_activity applies. While it is over budget, one
--       trailing element is removed from the lowest-priority non-empty sample, the flags and v_detail
--       are rebuilt, and it is measured again. No safety margin is applied or needed: this is not an
--       estimate of the enforcement surface, it is the enforcement surface.
--
-- Counts remain authoritative and are never trimmed; only samples shrink, and *_truncated tells the
-- reader it happened. Trim priority (first to lose elements -> last) is near_dups, dead_links,
-- consolidation, stale: the needs-review queue is the most actionable section and near-duplicates are
-- the noisiest, so the least useful content is dropped first.

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
  v_never_verified_count int := 0;
  v_near_dups_count int := 0;
  v_dead_links_count int := 0;
  v_consolidation_count int := 0;
  v_detail jsonb;
  v_guard int := 0;
  c_default_stale constant interval := interval '6 months';
  c_lead_intel_stale constant interval := interval '2 months';
  c_near_dup_distance constant double precision := 0.10;
  -- Defends log_activity's PER-STRING limit, which is expressed in characters (0034:370-372).
  c_json_char_cap constant int := 990;
  -- Defends log_activity's WHOLE-DETAIL limit, which is expressed in bytes (0034:365). Exact, not a
  -- margin: the loop below measures the identical expression the check applies.
  c_detail_byte_cap constant int := 4096;
  -- Max elements across all four samples is 15+10+15+15 = 55; 200 is a runaway backstop only.
  c_trim_guard constant int := 200;
begin
  if exists (
    select 1 from public.activity_log
    where action = 'librarian.digest' and detail->>'digest_date' = v_digest_date::text
  ) then
    return;
  end if;

  -- Needs-review queue: never-verified (verified_at is null) OR past its staleness half-life.
  -- 6 months generally, 2 months for CRM-linked lead intel.
  select count(*) into v_stale_count
  from public.memory_entries e
  where not e.archived
    and (
      e.verified_at is null
      or ((e.client_id is not null or e.deal_id is not null) and e.verified_at < now() - c_lead_intel_stale)
      or ((e.client_id is null and e.deal_id is null) and e.verified_at < now() - c_default_stale)
    );

  select count(*) into v_never_verified_count
  from public.memory_entries e
  where not e.archived and e.verified_at is null;

  -- nulls first: a never-verified entry outranks a merely stale one in the review queue.
  select coalesce(jsonb_agg(jsonb_build_object('name', q.name, 'verified_at', q.verified_at) order by q.verified_at asc nulls first), '[]'::jsonb)
  into v_stale
  from (
    select e.name, e.verified_at
    from public.memory_entries e
    where not e.archived
      and (
        e.verified_at is null
        or ((e.client_id is not null or e.deal_id is not null) and e.verified_at < now() - c_lead_intel_stale)
        or ((e.client_id is null and e.deal_id is null) and e.verified_at < now() - c_default_stale)
      )
    order by e.verified_at asc nulls first, e.name
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

  -- (a) PER-STRING limit, measured in CHARACTERS because that is the unit log_activity uses for it.
  -- Trim whole trailing elements so every encoded list stays valid JSON rather than being sliced into
  -- an invalid fragment.
  while length(v_stale::text) > c_json_char_cap and jsonb_array_length(v_stale) > 0 loop
    v_stale := v_stale - (jsonb_array_length(v_stale) - 1);
  end loop;
  while length(v_near_dups::text) > c_json_char_cap and jsonb_array_length(v_near_dups) > 0 loop
    v_near_dups := v_near_dups - (jsonb_array_length(v_near_dups) - 1);
  end loop;
  while length(v_dead_links::text) > c_json_char_cap and jsonb_array_length(v_dead_links) > 0 loop
    v_dead_links := v_dead_links - (jsonb_array_length(v_dead_links) - 1);
  end loop;
  while length(v_consolidation::text) > c_json_char_cap and jsonb_array_length(v_consolidation) > 0 loop
    v_consolidation := v_consolidation - (jsonb_array_length(v_consolidation) - 1);
  end loop;

  -- (b) WHOLE-DETAIL limit, measured in BYTES on the assembled object -- the same expression
  -- log_activity applies. Assemble, measure, drop one trailing element from the lowest-priority
  -- non-empty sample, repeat. Flags are rebuilt on every pass so they always describe what shipped.
  loop
    v_detail := jsonb_build_object(
      'source', 'cron',
      'digest_date', v_digest_date::text,
      'stale_count', v_stale_count,
      'never_verified_count', v_never_verified_count,
      'stale_json', v_stale::text,
      'stale_truncated', v_stale_count > jsonb_array_length(v_stale),
      'near_dups_count', v_near_dups_count,
      'near_dups_json', v_near_dups::text,
      'near_dups_truncated', v_near_dups_count > jsonb_array_length(v_near_dups),
      'dead_links_count', v_dead_links_count,
      'dead_links_json', v_dead_links::text,
      'dead_links_truncated', v_dead_links_count > jsonb_array_length(v_dead_links),
      'consolidation_count', v_consolidation_count,
      'consolidation_json', v_consolidation::text,
      'consolidation_truncated', v_consolidation_count > jsonb_array_length(v_consolidation)
    );

    exit when octet_length(v_detail::text) <= c_detail_byte_cap;

    if jsonb_array_length(v_near_dups) > 0 then
      v_near_dups := v_near_dups - (jsonb_array_length(v_near_dups) - 1);
    elsif jsonb_array_length(v_dead_links) > 0 then
      v_dead_links := v_dead_links - (jsonb_array_length(v_dead_links) - 1);
    elsif jsonb_array_length(v_consolidation) > 0 then
      v_consolidation := v_consolidation - (jsonb_array_length(v_consolidation) - 1);
    elsif jsonb_array_length(v_stale) > 0 then
      v_stale := v_stale - (jsonb_array_length(v_stale) - 1);
    else
      -- Every sample is empty and the scalar fields alone are still over budget. That is roughly
      -- 350 bytes of counts and keys, so it cannot happen in practice; emitting the counts-only
      -- digest is strictly better than raising and losing the report entirely.
      exit;
    end if;

    v_guard := v_guard + 1;
    exit when v_guard > c_trim_guard;
  end loop;

  perform public.log_activity(null, 'librarian.digest', null, null, v_detail);
end $$;

revoke execute on function public.run_memory_librarian() from public, anon, authenticated;
grant execute on function public.run_memory_librarian() to service_role;
