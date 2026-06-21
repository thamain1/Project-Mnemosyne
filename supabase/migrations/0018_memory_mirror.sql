-- Mnemosyne — 0018: memory mirror (one-way local→DB backup + share of Claude Code memory files).
-- Implements the v1.5 governance decision (TOKEN-GOVERNANCE-SYSTEM.md §16/§17/§18.1):
--   * Local markdown memory stays CANONICAL and passively read; this table is a MIRROR for
--     business continuity + remote-partner access. NOT semantic memory (no embeddings).
--   * G1 sync metadata (content_hash, *_at, mirror_version, sync_status) on every record.
--   * G5 secrets isolation — the RPC refuses content matching high-confidence secret patterns
--     (defense in depth; the push client also scans and fails closed).
--   * G7 one-way — writes only via this service-role RPC (local→DB). No DB→local writeback path.
-- Follows the 0013/0014 write-lockdown pattern: SELECT-only RLS for the team, writes revoked
-- from the Data-API roles, the sole write path is a SECURITY DEFINER service-role-only RPC that
-- validates the actor (fail closed), strict payload, and audits atomically via log_activity.
-- Additive. UNAPPLIED until Aegis QC + Jesse go.

create table if not exists public.memory_mirror (
  id                uuid primary key default gen_random_uuid(),
  project_slug      text not null default 'claude-code-memory',
  source_path       text not null unique,            -- canonical relative path; UNIQUE = idempotent upsert key
  source_kind       text not null default 'memory_topic_file',
  content           text not null,                   -- raw markdown, verbatim
  content_hash      text not null,                   -- sha256 hex (64 chars) of content
  byte_size         integer not null,
  local_modified_at timestamptz,                     -- local file mtime if available
  mirrored_at       timestamptz not null default now(),
  branch            text,                            -- if available (the ~/.claude memory dir is usually not a repo)
  commit_sha        text,                            -- if available
  mirror_version    integer not null default 1,      -- bumped on each content change
  sync_status       text not null default 'current', -- current | stale | failed | unknown
  created_by        uuid references public.team_members(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint memory_mirror_kind_chk   check (source_kind in ('memory_index','memory_topic_file','claude_md','other')),
  constraint memory_mirror_status_chk check (sync_status in ('current','stale','failed','unknown')),
  constraint memory_mirror_hash_chk   check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint memory_mirror_size_chk   check (byte_size >= 0 and length(content) <= 1000000)
);

create index if not exists memory_mirror_project_idx on public.memory_mirror (project_slug);

-- RLS: team members read; nobody writes via the Data API (writes go through the RPC below).
alter table public.memory_mirror enable row level security;
drop policy if exists memory_mirror_team_select on public.memory_mirror;
create policy memory_mirror_team_select on public.memory_mirror
  for select using (public.is_team_member());
-- Tightest grant: strip ALL default privileges from the Data-API roles, then re-grant only SELECT
-- (RLS still gates which rows). Removes the default TRUNCATE/TRIGGER/REFERENCES too — write gate by
-- grant, not convention (per the project's grant-lockdown lesson), even though PostgREST can't reach them.
revoke all on public.memory_mirror from anon, authenticated;
grant select on public.memory_mirror to anon, authenticated;

-- Sole write path. SECURITY DEFINER, empty search_path, service_role-only. Upsert on source_path
-- (files change, so unlike save_document this updates in place + bumps mirror_version). Atomic audit.
create or replace function public.upsert_memory_mirror(p_payload jsonb, p_actor uuid, p_audit jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id          uuid;
  v_path        text := p_payload->>'source_path';
  v_kind        text := coalesce(p_payload->>'source_kind', 'memory_topic_file');
  v_slug        text := coalesce(p_payload->>'project_slug', 'claude-code-memory');
  v_content     text := p_payload->>'content';
  v_hash        text := p_payload->>'content_hash';
  v_status      text := coalesce(p_payload->>'sync_status', 'current');
  v_existing    uuid;
  v_existing_hash text;
  -- high-confidence secret patterns (G5 server-side floor; mirrors mcp/lib secret scan)
  c_secret_re constant text :=
    '(sk_(live|test)_[A-Za-z0-9]{8,})|(sbp_[A-Za-z0-9]{20,})|(sb_(secret|publishable)_[A-Za-z0-9_]+)|(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,})|(AIza[0-9A-Za-z_-]{30,})|(AKIA[0-9A-Z]{16})|(ghp_[A-Za-z0-9]{30,})|(-----BEGIN [A-Z ]*PRIVATE KEY-----)|(xox[baprs]-[A-Za-z0-9-]{8,})';
begin
  -- actor: active team member, fail closed (re-validated inside log_activity too)
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'upsert_memory_mirror: actor must be an active team member';
  end if;
  -- strict payload shape
  if exists (select 1 from jsonb_object_keys(p_payload) k
             where k not in ('source_path','source_kind','project_slug','content','content_hash',
                             'byte_size','local_modified_at','branch','commit_sha','sync_status')) then
    raise exception 'upsert_memory_mirror: unexpected key in payload';
  end if;
  -- field validation
  if v_path is null or v_path = '' or length(v_path) > 400 then raise exception 'upsert_memory_mirror: source_path must be a non-empty string <=400 chars'; end if;
  if v_path ~ '\.\.' or v_path ~ '^[/\\]' or v_path ~ '^[A-Za-z]:' then raise exception 'upsert_memory_mirror: source_path must be repo-relative (no .. , no absolute path)'; end if;
  if v_kind not in ('memory_index','memory_topic_file','claude_md','other') then raise exception 'upsert_memory_mirror: bad source_kind %', v_kind; end if;
  if v_status not in ('current','stale','failed','unknown') then raise exception 'upsert_memory_mirror: bad sync_status %', v_status; end if;
  if v_content is null or v_content = '' or length(v_content) > 1000000 then raise exception 'upsert_memory_mirror: content must be a non-empty string <=1000000 chars'; end if;
  if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' then raise exception 'upsert_memory_mirror: content_hash must be a 64-char sha256 hex'; end if;
  if encode(extensions.digest(v_content, 'sha256'), 'hex') <> v_hash then raise exception 'upsert_memory_mirror: content_hash does not match content'; end if;
  -- G5: refuse secret-bearing content (fail closed)
  if v_content ~ c_secret_re then raise exception 'upsert_memory_mirror: content matches a secret pattern — secrets must never be mirrored (scrub the file, use the vault)'; end if;

  select id, content_hash into v_existing, v_existing_hash from public.memory_mirror where source_path = v_path;

  if v_existing is null then
    insert into public.memory_mirror (project_slug, source_path, source_kind, content, content_hash,
                                      byte_size, local_modified_at, branch, commit_sha, sync_status,
                                      created_by, mirror_version, mirrored_at)
      values (v_slug, v_path, v_kind, v_content, v_hash,
              coalesce((p_payload->>'byte_size')::int, octet_length(v_content)),
              (p_payload->>'local_modified_at')::timestamptz, p_payload->>'branch', p_payload->>'commit_sha',
              v_status, p_actor, 1, now())
      returning id into v_id;
  else
    update public.memory_mirror set
      project_slug = v_slug, source_kind = v_kind, content = v_content, content_hash = v_hash,
      byte_size = coalesce((p_payload->>'byte_size')::int, octet_length(v_content)),
      local_modified_at = (p_payload->>'local_modified_at')::timestamptz,
      branch = p_payload->>'branch', commit_sha = p_payload->>'commit_sha', sync_status = v_status,
      mirror_version = mirror_version + (case when content_hash is distinct from v_hash then 1 else 0 end),
      mirrored_at = now(), updated_at = now()
      where id = v_existing
      returning id into v_id;
  end if;

  perform public.log_activity(p_actor, 'memory.mirror_upsert', 'memory_mirror', v_id, coalesce(p_audit, '{}'::jsonb));
  return v_id;
end $$;

revoke execute on function public.upsert_memory_mirror(jsonb, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.upsert_memory_mirror(jsonb, uuid, jsonb) to service_role;
