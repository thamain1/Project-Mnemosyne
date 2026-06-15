-- Project 4ward — 0010: secrets-vault encryption-at-rest backend = Supabase Vault.
-- UNAPPLIED — submitted for Aegis PRE-APPLY review (thread 0009). Addresses all 8 design-review
-- corrections. Apply held until pre-apply sign-off + Jesse's go.
--
-- Secret VALUES move into Supabase Vault (vault.secrets); only ciphertext lives at rest, encrypted under
-- the platform keyring. NB: Vault ciphertext IS present in backups/PITR/replication — the plaintext and
-- the encryption key are not (so a public.* dump or a backup never yields a usable secret). public.secrets_vault
-- keeps METADATA + a unique, non-null vault_secret_id pointer. Three definer RPCs (owner postgres reaches
-- vault.*), empty search_path, fully-qualified, audited via the hardened log_activity:
--   * set_secret(actor, meta, secret)      — active-ADMIN-only write/update through Vault.
--   * get_secret(id)                        — authenticated read; actor = auth.uid(); sensitivity-gated.
--   * get_secret_operator(actor, id)        — service-role-only local-operator read; explicit active actor.

-- ── 0. fail-closed preconditions (Aegis #7) ───────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise exception '0010 abort: supabase_vault extension not installed';
  end if;
  if (select count(*) from public.secrets_vault) <> 0 then
    raise exception '0010 abort: secrets_vault is not empty — refusing to migrate plaintext values';
  end if;
end $$;

-- ── 1. schema: drop plaintext sink; add unique, project-aware identity + vault pointer ────────────────
alter table public.secrets_vault drop column if exists encrypted_value;
alter table public.secrets_vault add column if not exists vault_secret_id uuid;
-- table is empty, so enforce NOT NULL + uniqueness now (Aegis #5: no orphan / no shared-secret rows)
alter table public.secrets_vault alter column vault_secret_id set not null;
create unique index if not exists uq_secrets_vault_vault_secret_id on public.secrets_vault (vault_secret_id);
-- project-aware logical identity, NULLs treated consistently (Aegis #4); PG17 NULLS NOT DISTINCT
create unique index if not exists uq_secrets_vault_identity
  on public.secrets_vault (project_id, service, environment, scope) nulls not distinct;

-- ── 2. remove direct metadata write bypass (Aegis #3 + pre-apply #1) — ALL writes via set_secret/retire ─
drop policy if exists secrets_vault_admin_write on public.secrets_vault;
-- revoke DML from service_role too: the operator holds that key, so a bug/adjacent tool could otherwise
-- bypass set_secret's validation/audit/Vault lifecycle. Definer RPCs run as owner (postgres) — unaffected.
revoke insert, update, delete on public.secrets_vault from anon, authenticated, service_role;
-- (keep the metadata SELECT policy + column grants from 0002; definer RPCs run as owner and bypass RLS)

-- ── 3. deny direct Vault access outside the controlled RPCs (Aegis #5) ────────────────────────────────
-- service_role currently holds SELECT/DELETE on vault.decrypted_secrets — revoke it; the RPCs run as
-- owner (postgres), so they are unaffected. Guarded so a privilege quirk surfaces as a notice, not an abort;
-- the post-apply gate asserts the effective denial regardless.
do $$
begin
  begin
    revoke all on vault.decrypted_secrets from anon, authenticated, service_role;
    revoke all on vault.secrets          from anon, authenticated, service_role;
  exception when insufficient_privilege then
    raise notice '0010: could not revoke direct vault grants (insufficient privilege) — gate must assert denial';
  end;
end $$;

-- ── 4. set_secret: active-ADMIN-only write via Vault, atomic audit ────────────────────────────────────
create or replace function public.set_secret(p_actor uuid, p_meta jsonb, p_secret text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  c_secret_re constant text := '(sk_(live|test)_[A-Za-z0-9]|sbp_[A-Za-z0-9]{20}|sb_(secret|publishable)_|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{30}|-----BEGIN [A-Z ]*PRIVATE KEY-----)';
  v_service text; v_env text; v_scope text; v_sens text; v_proj uuid;
  v_row_id uuid;
  v_vid    uuid;
begin
  -- active ADMIN actor (Aegis #2) — service-role ACL alone is insufficient
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active and role = 'admin') then
    raise exception 'set_secret: actor must be an active admin';
  end if;
  -- p_meta SHAPE first, before any dereference/cast (pre-apply #3): fail closed on null/array/scalar
  if p_meta is null or jsonb_typeof(p_meta) <> 'object' then raise exception 'set_secret: meta must be a JSON object'; end if;
  if exists (select 1 from jsonb_object_keys(p_meta) k where k not in ('service','environment','scope','sensitivity','project_id')) then
    raise exception 'set_secret: unexpected key in meta';
  end if;
  -- now safe to read fields
  v_service := p_meta->>'service';
  v_env     := p_meta->>'environment';
  v_scope   := p_meta->>'scope';
  v_sens    := coalesce(p_meta->>'sensitivity', 'admin');
  if nullif(p_meta->>'project_id','') is not null then
    begin
      v_proj := (p_meta->>'project_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'set_secret: project_id must be a uuid';
    end;
  end if;
  if v_service is null or v_service = '' or length(v_service) > 100 then raise exception 'set_secret: service required (<=100 chars)'; end if;
  if v_env   is not null and length(v_env)   > 100 then raise exception 'set_secret: environment too long'; end if;
  if v_scope is not null and length(v_scope) > 200 then raise exception 'set_secret: scope too long'; end if;
  if v_sens not in ('team','restricted','admin') then raise exception 'set_secret: bad sensitivity'; end if;
  if p_secret is null or p_secret = '' then raise exception 'set_secret: secret must be non-empty'; end if;
  if octet_length(p_secret) > 16384 then raise exception 'set_secret: secret too large (>16KB)'; end if;
  -- metadata must not itself carry secrets (Aegis #6)
  if (coalesce(v_service,'') || ' ' || coalesce(v_env,'') || ' ' || coalesce(v_scope,'')) ~* c_secret_re then
    raise exception 'set_secret: metadata appears to contain a secret';
  end if;

  -- serialize same-identity writes (no TOCTOU between lookup and upsert)
  perform pg_advisory_xact_lock(hashtext('p4w-secret:' || coalesce(v_proj::text,'-') || ':' || v_service || ':' || coalesce(v_env,'-') || ':' || coalesce(v_scope,'-')));

  select id, vault_secret_id into v_row_id, v_vid
  from public.secrets_vault
  where project_id is not distinct from v_proj
    and service = v_service
    and environment is not distinct from v_env
    and scope is not distinct from v_scope;

  if v_row_id is not null then
    perform vault.update_secret(v_vid, p_secret);
    update public.secrets_vault
      set sensitivity = v_sens::public.sensitivity_tier, ref_location = 'supabase_vault'
      where id = v_row_id;
  else
    -- pre-generate row id so the Vault name is the STABLE metadata UUID (Aegis #4); no null window
    v_row_id := gen_random_uuid();
    v_vid := vault.create_secret(p_secret, 'p4w:' || v_row_id::text, 'Project 4ward secret');
    insert into public.secrets_vault (id, project_id, service, environment, scope, ref_location, sensitivity, vault_secret_id, created_by)
      values (v_row_id, v_proj, v_service, v_env, v_scope, 'supabase_vault', v_sens::public.sensitivity_tier, v_vid, p_actor);
  end if;

  -- atomic audit via the hardened path (Aegis #6); same txn, rolls back with the write on failure
  perform public.log_activity(p_actor, 'secret.write', 'secrets_vault', v_row_id,
            jsonb_build_object('service', v_service, 'environment', v_env, 'scope', v_scope, 'sensitivity', v_sens));
  return v_row_id;
end $$;

-- ── 5. get_secret: AUTHENTICATED read (actor = auth.uid()), sensitivity-gated ─────────────────────────
create or replace function public.get_secret(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_vid uuid; v_sens public.sensitivity_tier; v text; v_actor uuid := (select auth.uid());
begin
  if not public.is_team_member() then raise exception 'not authorized'; end if;
  select vault_secret_id, sensitivity into v_vid, v_sens from public.secrets_vault where id = p_id;
  if v_vid is null then raise exception 'get_secret: no secret for id %', p_id; end if;
  -- sensitivity authorization (Aegis #2): admin/restricted are admin-only; team is any active member
  if v_sens in ('admin','restricted') and not public.is_admin() then
    raise exception 'get_secret: not authorized for % secret', v_sens;
  end if;
  select decrypted_secret into v from vault.decrypted_secrets where id = v_vid;
  if v is null then raise exception 'get_secret: vault secret missing for id %', p_id; end if;
  perform public.log_activity(v_actor, 'secret.read', 'secrets_vault', p_id, '{}'::jsonb);
  return v;
end $$;

-- ── 6. get_secret_operator: SERVICE-ROLE-ONLY local-operator read, explicit active actor ──────────────
create or replace function public.get_secret_operator(p_actor uuid, p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_vid uuid; v_sens public.sensitivity_tier; v text; v_is_admin boolean;
begin
  select (active and role = 'admin') into v_is_admin from public.team_members where id = p_actor;
  if not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'get_secret_operator: actor must be an active team member';
  end if;
  select vault_secret_id, sensitivity into v_vid, v_sens from public.secrets_vault where id = p_id;
  if v_vid is null then raise exception 'get_secret_operator: no secret for id %', p_id; end if;
  if v_sens in ('admin','restricted') and not coalesce(v_is_admin, false) then
    raise exception 'get_secret_operator: not authorized for % secret', v_sens;
  end if;
  select decrypted_secret into v from vault.decrypted_secrets where id = v_vid;
  if v is null then raise exception 'get_secret_operator: vault secret missing for id %', p_id; end if;
  perform public.log_activity(p_actor, 'secret.read', 'secrets_vault', p_id, jsonb_build_object('via','operator'));
  return v;
end $$;

-- ── 6b. retire_secret: the ONLY delete path (active-admin; atomic metadata+Vault) ────────────────────
-- Direct DELETE on secrets_vault is revoked from all app roles (section 2), so a secret can only be removed
-- here — atomically dropping the Vault row and the metadata row together (no orphan in either direction).
create or replace function public.retire_secret(p_actor uuid, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_vid uuid; v_n int;
begin
  -- 0. validate + capture metadata BEFORE any mutation
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active and role = 'admin') then
    raise exception 'retire_secret: actor must be an active admin';
  end if;
  select vault_secret_id into v_vid from public.secrets_vault where id = p_id;
  if v_vid is null then raise exception 'retire_secret: no secret for id %', p_id; end if;
  -- 1. audit FIRST (fail-safe ordering, Aegis r2): audit failure ⇒ nothing deleted
  perform public.log_activity(p_actor, 'secret.retire', 'secrets_vault', p_id, '{}'::jsonb);
  -- 2. delete the public metadata row; raise if it didn't hit exactly one
  delete from public.secrets_vault where id = p_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'retire_secret: metadata delete affected % rows', v_n; end if;
  -- 3. delete the Vault row LAST (non-recoverable); raise if it didn't hit exactly one.
  --    All steps share one txn — any raise here rolls back the audit + metadata delete → no orphan.
  delete from vault.secrets where id = v_vid;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'retire_secret: vault delete affected % rows', v_n; end if;
end $$;

-- ── 7. ACLs ───────────────────────────────────────────────────────────────────
revoke execute on function public.set_secret(uuid, jsonb, text)        from public, anon, authenticated;
grant  execute on function public.set_secret(uuid, jsonb, text)        to service_role;
revoke execute on function public.get_secret(uuid)                     from public, anon;
grant  execute on function public.get_secret(uuid)                     to authenticated, service_role;
revoke execute on function public.get_secret_operator(uuid, uuid)      from public, anon, authenticated;
grant  execute on function public.get_secret_operator(uuid, uuid)      to service_role;
revoke execute on function public.retire_secret(uuid, uuid)            from public, anon, authenticated;
grant  execute on function public.retire_secret(uuid, uuid)            to service_role;
