-- Mnemosyne — 0017: Sales Factory C5.2 — upsert_contact RPC. Additive. UNAPPLIED until Aegis QC + Jesse go.
--
-- contacts was already write-locked in 0015 (SELECT-only for members; ins/upd/del revoked from anon/
-- authenticated). This adds the only write path: a service-role-only definer RPC, actor = authenticated uid,
-- fail-closed active-member, atomic audit. PATCH semantics from the start (the 0016 lesson) — on update, a
-- column changes only if its key is present in the payload. A contact belongs to a client (client_id required
-- on insert, must exist). Per-deal activity needs NO new backend: it reuses /api/log-update + log_activity
-- (action 'deal.note', entity_type 'deals', entity_id = deal id), read from the team-readable activity_log.

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
  if exists (select 1 from jsonb_object_keys(p_payload) k where k not in ('id','client_id','name','email','role')) then
    raise exception 'upsert_contact: unexpected key in payload';
  end if;
  -- validate any PRESENT field
  if p_payload ? 'name' and (jsonb_typeof(p_payload->'name') is distinct from 'string' or btrim(coalesce(v_name,'')) = '' or length(v_name) > 200) then
    raise exception 'upsert_contact: name required (<=200 chars)';
  end if;
  if p_payload ? 'email' and jsonb_typeof(p_payload->'email') not in ('string','null') then raise exception 'upsert_contact: email must be a string'; end if;
  if (p_payload->>'email') is not null and length(p_payload->>'email') > 200 then raise exception 'upsert_contact: email too long (<=200)'; end if;
  if p_payload ? 'role' and jsonb_typeof(p_payload->'role') not in ('string','null') then raise exception 'upsert_contact: role must be a string'; end if;
  if (p_payload->>'role') is not null and length(p_payload->>'role') > 120 then raise exception 'upsert_contact: role too long (<=120)'; end if;
  if v_client_id is not null and not exists (select 1 from public.clients where id = v_client_id) then raise exception 'upsert_contact: client % not found', v_client_id; end if;

  if v_id is null then
    if not (p_payload ? 'name') or btrim(coalesce(v_name,'')) = '' then raise exception 'upsert_contact: name required'; end if;
    if v_client_id is null then raise exception 'upsert_contact: client_id required'; end if;
    insert into public.contacts (client_id, name, email, role)
      values (v_client_id, btrim(v_name), p_payload->>'email', p_payload->>'role')
      returning id into v_id;
  else
    -- PATCH: change a column only if its key is present
    update public.contacts set
      client_id = case when p_payload ? 'client_id' then v_client_id        else client_id end,
      name      = case when p_payload ? 'name'      then btrim(v_name)      else name      end,
      email     = case when p_payload ? 'email'     then p_payload->>'email' else email     end,
      role      = case when p_payload ? 'role'      then p_payload->>'role'  else role      end
      where id = v_id;
    if not found then raise exception 'upsert_contact: contact % not found', v_id; end if;
  end if;
  perform public.log_activity(p_actor, 'crm.contact_save', 'contacts', v_id, coalesce(p_audit,'{}'::jsonb));
  return v_id;
end $$;

revoke execute on function public.upsert_contact(jsonb, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.upsert_contact(jsonb, uuid, jsonb) to service_role;
