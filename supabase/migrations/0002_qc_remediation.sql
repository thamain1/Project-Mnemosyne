-- Project 4ward — 0002 corrective migration (Phase 0 QC remediation, per Aegis review of a4dda1d)
-- Additive/corrective. Do NOT edit the already-applied 0001. Written to be safely re-runnable.
--
-- Access model (refined 2026-06-14 w/ Jesse): information stays OPEN to every team member; only
-- high-blast-radius INTEGRITY actions are gated:
--   * knowledge/work tables (projects, memory, documents, deals, clients, contacts, infra registry)
--     -> full read+write for all team members (unchanged from 0001)
--   * team_members  -> all read; writes admin/service-role only + last-admin survivability invariant
--   * secrets_vault -> metadata readable; the VALUE only via audited get_secret(); writes admin/service
--   * activity_log  -> team-readable, APPEND-ONLY (no user insert/update/delete; written via definer/service)
--   * repos (code)  -> all read; WRITE requires can_code (admins + named devs, e.g. Fagel/Hill)

-- ── 0. can_code capability flag ───────────────────────────────────────────────
alter table public.team_members add column if not exists can_code boolean not null default false;

-- ── 1. Harden SECURITY DEFINER helpers: empty search_path, qualified names, locked execute ──
create or replace function public.is_team_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_members where id = (select auth.uid()) and active);
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_members
                 where id = (select auth.uid()) and active and role = 'admin');
$$;

create or replace function public.current_member_role()
returns public.member_role language sql stable security definer set search_path = '' as $$
  select role from public.team_members where id = (select auth.uid()) and active;
$$;

create or replace function public.can_code()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_members
                 where id = (select auth.uid()) and active and (can_code or role = 'admin'));
$$;

revoke execute on function public.is_team_member()      from public;
revoke execute on function public.is_admin()            from public;
revoke execute on function public.current_member_role() from public;
revoke execute on function public.can_code()            from public;
grant  execute on function public.is_team_member()      to authenticated, service_role;
grant  execute on function public.is_admin()            to authenticated, service_role;
grant  execute on function public.current_member_role() to authenticated, service_role;
grant  execute on function public.can_code()            to authenticated, service_role;

-- ── 2. Audited secret retrieval (hardened) ────────────────────────────────────
create or replace function public.get_secret(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  if not public.is_team_member() then
    raise exception 'not authorized';
  end if;
  select encrypted_value into v from public.secrets_vault where id = p_id;
  insert into public.activity_log (actor_id, action, entity_type, entity_id)
    values ((select auth.uid()), 'secret.read', 'secrets_vault', p_id);
  return v;
end $$;
revoke execute on function public.get_secret(uuid) from public, anon;
grant  execute on function public.get_secret(uuid) to authenticated, service_role;
-- Note: anon keeps execute on the boolean helpers (is_team_member/is_admin/can_code/current_member_role)
-- on purpose — they return false for anon and must be evaluable during RLS policy checks. Only the
-- secret-bearing get_secret() is locked away from anon.

-- ── 3. team_members: read-all, write admin/service-role only ───────────────────
drop policy if exists team_members_team_all     on public.team_members;
drop policy if exists team_members_select        on public.team_members;
drop policy if exists team_members_admin_write   on public.team_members;
create policy team_members_select      on public.team_members for select using (public.is_team_member());
create policy team_members_admin_write on public.team_members for all
  using (public.is_admin()) with check (public.is_admin());

-- Survivability invariant: never remove/demote/deactivate the last active admin (fires for ALL roles).
create or replace function public.protect_last_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
declare remaining int;
begin
  if tg_op = 'DELETE' then
    if old.role = 'admin' and old.active then
      select count(*) into remaining from public.team_members
        where active and role = 'admin' and id <> old.id;
      if remaining = 0 then raise exception 'cannot remove the last active admin'; end if;
    end if;
    return old;
  else
    if (old.role = 'admin' and old.active) and (new.role <> 'admin' or new.active = false) then
      select count(*) into remaining from public.team_members
        where active and role = 'admin' and id <> old.id;
      if remaining = 0 then raise exception 'cannot demote/deactivate the last active admin'; end if;
    end if;
    return new;
  end if;
end $$;
drop trigger if exists trg_protect_last_admin on public.team_members;
create trigger trg_protect_last_admin before update or delete on public.team_members
  for each row execute function public.protect_last_admin();

-- ── 4. secrets_vault: metadata readable, VALUE only via get_secret() ───────────
drop policy if exists secrets_vault_team_all     on public.secrets_vault;
drop policy if exists secrets_vault_select        on public.secrets_vault;
drop policy if exists secrets_vault_admin_write   on public.secrets_vault;
create policy secrets_vault_select      on public.secrets_vault for select using (public.is_team_member());
create policy secrets_vault_admin_write on public.secrets_vault for all
  using (public.is_admin()) with check (public.is_admin());
-- Column-level: drop blanket table SELECT, grant only metadata cols (NOT encrypted_value).
revoke select on public.secrets_vault from anon, authenticated;
grant  select (id, project_id, service, environment, scope, ref_location, sensitivity, created_by, created_at)
  on public.secrets_vault to authenticated;

-- ── 5. activity_log: team-readable, APPEND-ONLY (no user write policy) ─────────
drop policy if exists activity_log_team_all on public.activity_log;
drop policy if exists activity_log_select    on public.activity_log;
create policy activity_log_select on public.activity_log for select using (public.is_team_member());
-- No INSERT/UPDATE/DELETE policy: users cannot forge or mutate. Writes go via SECURITY DEFINER
-- functions (e.g. get_secret) or the service role, both of which bypass RLS.
revoke insert, update, delete on public.activity_log from anon, authenticated;

-- ── 6. repos (code): read-all, WRITE requires can_code ────────────────────────
drop policy if exists repos_team_all   on public.repos;
drop policy if exists repos_select      on public.repos;
drop policy if exists repos_code_write  on public.repos;
create policy repos_select     on public.repos for select using (public.is_team_member());
create policy repos_code_write on public.repos for all
  using (public.can_code()) with check (public.can_code());

-- ── 7. Schema modeling fixes (Aegis required follow-ups) ──────────────────────
create index if not exists idx_memory_entries_project on public.memory_entries (project_id);
create index if not exists idx_documents_project       on public.documents (project_id);
create index if not exists idx_document_chunks_document on public.document_chunks (document_id);
create index if not exists idx_repos_project            on public.repos (project_id);
create index if not exists idx_databases_project        on public.databases (project_id);
create index if not exists idx_deployments_project      on public.deployments (project_id);
create index if not exists idx_dev_servers_project      on public.dev_servers (project_id);
create index if not exists idx_contacts_client          on public.contacts (client_id);
create index if not exists idx_deals_client             on public.deals (client_id);
create index if not exists idx_activity_log_actor       on public.activity_log (actor_id);

do $$ begin
  alter table public.document_chunks
    add constraint document_chunks_doc_chunk_uniq unique (document_id, chunk_index);
exception when duplicate_table then null; when duplicate_object then null; end $$;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists trg_projects_updated_at       on public.projects;
drop trigger if exists trg_memory_entries_updated_at on public.memory_entries;
create trigger trg_projects_updated_at       before update on public.projects
  for each row execute function public.set_updated_at();
create trigger trg_memory_entries_updated_at before update on public.memory_entries
  for each row execute function public.set_updated_at();
