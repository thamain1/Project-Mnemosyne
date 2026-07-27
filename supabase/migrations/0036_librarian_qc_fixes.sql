-- Mnemosyne - 0036: Unit L QC fixes (thread 0037, Aegis QC record 2026-07-27).
-- HELD UNAPPLIED until QC + Jesse apply-go.
--
-- Number note: 0035 is reserved for Unit R (recall scale). This lands as 0036 by Aegis's
-- recommendation and Jesse's call, so 0035 stays claimed and unapplied.
--
-- Two defects from the Unit L QC record, both in run_memory_librarian(). No schema change.
--
-- (1) verified_at NULL evaded the stale queue permanently. Both stale arms tested
--     `e.verified_at < now() - interval`, which is UNKNOWN (not true) for NULL, so the row was
--     filtered out. 0034 backfilled only rows that existed at apply time, and no creation path sets
--     the column -- remember_memory (0009:125-130), ingest_memory_entry (0027:118-125),
--     upsert_client_brief (0030:99-100), record_agent_outcome (0031:176-180) all omit it. Three
--     memories created within hours of the 0034 apply were already permanently invisible.
--
--     DECISION (Jesse, 2026-07-27): NULL stays MEANINGFUL and means "never verified". Deliberately
--     NOT fixed with `set default now()` + `not null` + backfill: defaulting would stamp a brand-new,
--     unreviewed memory as freshly verified, which inverts the librarian's purpose. Instead the
--     librarian explicitly queues NULL as unverified, so new memories surface for review. The column
--     stays nullable with no default, and the existing NULL rows need no backfill -- they are
--     correctly "never verified" and now show up on their own.
--
-- (2) Sample truncation was silent. `*_count` was honest but a consumer could not tell a complete
--     sample from a capped one without comparing array length to the count. Adds four flat booleans,
--     matching the honest-truncation behaviour brief and client_360 already use. The flag is computed
--     AFTER the trim loop as `count > jsonb_array_length(sample)`, so it covers BOTH the SQL LIMIT and
--     the character trim.
--
-- Byte-budget note: log_activity caps detail at 4096 bytes (0034:365). Four sections at the old
-- 950-char cap plus the new keys lands around 4050 and would risk tripping that ceiling, turning a
-- reporting nicety into a hard digest failure. c_json_text_cap drops to 820 for headroom; the samples
-- are illustrative and the counts remain authoritative.

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
  c_default_stale constant interval := interval '6 months';
  c_lead_intel_stale constant interval := interval '2 months';
  c_near_dup_distance constant double precision := 0.10;
  c_json_text_cap constant int := 820;
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

  -- Reported separately so "never reviewed" is visible without parsing the sample. Scalar only --
  -- a fifth 800-char section would not fit the 4096-byte detail cap.
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

  -- Computed AFTER the trim loops, so one flag covers both the SQL LIMIT and the character trim.
  perform public.log_activity(null, 'librarian.digest', null, null, jsonb_build_object(
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
  ));
end $$;

revoke execute on function public.run_memory_librarian() from public, anon, authenticated;
grant execute on function public.run_memory_librarian() to service_role;
