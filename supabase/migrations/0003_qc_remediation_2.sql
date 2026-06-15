-- Project 4ward — 0003 corrective migration (Aegis re-review of 7504ab0)
-- Closes two survivability bypasses TRUNCATE + last-admin race, and makes anon execute on RLS
-- helpers explicit. Additive, re-runnable. Do NOT edit applied 0001/0002.

-- ── 1. Revoke TRUNCATE on all app tables (RLS + row triggers do NOT apply to TRUNCATE) ──
-- Without this, a role holding Supabase's default table-level TRUNCATE could wipe team_members /
-- activity_log outside the policy model and the last-admin trigger.
do $$
declare t text;
begin
  foreach t in array array[
    'team_members','projects','repos','databases','deployments','dev_servers',
    'memory_entries','documents','document_chunks','secrets_vault',
    'clients','contacts','deals','activity_log'
  ] loop
    execute format('revoke truncate on public.%I from anon, authenticated;', t);
  end loop;
end $$;

-- ── 2. Make anon EXECUTE on the boolean RLS helpers explicit (supersedes 0002 comment) ──
-- Intentional: these return false for anon and MUST be evaluable during RLS policy checks for any
-- anon-reachable table. get_secret() stays anon-revoked (it returns secret material).
grant execute on function public.is_team_member()      to anon;
grant execute on function public.is_admin()            to anon;
grant execute on function public.can_code()            to anon;
grant execute on function public.current_member_role() to anon;

-- ── 3. Fix last-admin concurrency race (TOCTOU) with a txn-scoped advisory lock ──
-- Serializes all admin-affecting removals/demotions so two sessions cannot each drop a different
-- admin against a stale snapshot and both commit to zero admins.
create or replace function public.protect_last_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
declare remaining int;
begin
  if tg_op = 'DELETE' then
    if old.role = 'admin' and old.active then
      perform pg_advisory_xact_lock(hashtext('project4ward.team_members.admin_guard')::bigint);
      select count(*) into remaining from public.team_members
        where active and role = 'admin' and id <> old.id;
      if remaining = 0 then raise exception 'cannot remove the last active admin'; end if;
    end if;
    return old;
  else
    if (old.role = 'admin' and old.active) and (new.role <> 'admin' or new.active = false) then
      perform pg_advisory_xact_lock(hashtext('project4ward.team_members.admin_guard')::bigint);
      select count(*) into remaining from public.team_members
        where active and role = 'admin' and id <> old.id;
      if remaining = 0 then raise exception 'cannot demote/deactivate the last active admin'; end if;
    end if;
    return new;
  end if;
end $$;
