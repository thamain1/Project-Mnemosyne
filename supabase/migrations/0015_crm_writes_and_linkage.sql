-- Mnemosyne — 0015: Sales Factory C5.1 — CRM write subsystem + deal↔document linkage. Additive.
-- UNAPPLIED until Aegis QC + Jesse go.
--
-- Applies the banked write-gate lesson (thread 0018 / 0014) PROACTIVELY to the CRM tables: clients, contacts,
-- and deals still carried the survivability-era `for all using(is_team_member())` policy + default Data-API
-- insert/update/delete grants, so a member could write rows directly via PostgREST and bypass any endpoint.
-- This migration makes CRM writes server-mediated by POLICY + GRANT: members get read-only, writes go through
-- service-role RPCs (actor = authenticated uid, fail-closed active-member, atomic audit).
--
-- Adds:
--   * documents.deal_id  — nullable FK → deals(id) on delete set null. A document belongs to one deal; a deal
--     has many docs (MOU/SOW/invoice). Set via link_document_deal (service-role; documents are write-locked
--     by 0014, so only a definer RPC can touch deal_id).
--   * upsert_client / upsert_deal / link_document_deal — SECURITY DEFINER, empty search_path, service_role-only.

-- ── 1) lock down CRM writes (read-only for members; writes via service-role RPC) ──────────────
drop policy if exists clients_team_all  on public.clients;
drop policy if exists contacts_team_all on public.contacts;
drop policy if exists deals_team_all    on public.deals;
-- idempotent for partial-migration recovery
drop policy if exists clients_team_select  on public.clients;
drop policy if exists contacts_team_select on public.contacts;
drop policy if exists deals_team_select    on public.deals;

create policy clients_team_select  on public.clients  for select using (public.is_team_member());
create policy contacts_team_select on public.contacts for select using (public.is_team_member());
create policy deals_team_select    on public.deals    for select using (public.is_team_member());

revoke insert, update, delete on public.clients  from anon, authenticated;
revoke insert, update, delete on public.contacts from anon, authenticated;
revoke insert, update, delete on public.deals    from anon, authenticated;

-- ── 2) deal ↔ document linkage ───────────────────────────────────────────────────────────────
alter table public.documents add column if not exists deal_id uuid references public.deals (id) on delete set null;
create index if not exists documents_deal_id_idx on public.documents (deal_id);

-- ── 3) upsert_client: create or update a client ────────────────────────────────────────────────
create or replace function public.upsert_client(p_payload jsonb, p_actor uuid, p_audit jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id   uuid := nullif(p_payload->>'id','')::uuid;
  v_name text := p_payload->>'name';
begin
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'upsert_client: actor must be an active team member';
  end if;
  if exists (select 1 from jsonb_object_keys(p_payload) k where k not in ('id','name','notes')) then
    raise exception 'upsert_client: unexpected key in payload';
  end if;
  if v_name is null or btrim(v_name) = '' or length(v_name) > 200 then raise exception 'upsert_client: name required (<=200 chars)'; end if;
  if p_payload ? 'notes' and jsonb_typeof(p_payload->'notes') not in ('string','null') then raise exception 'upsert_client: notes must be a string'; end if;
  if (p_payload->>'notes') is not null and length(p_payload->>'notes') > 4000 then raise exception 'upsert_client: notes too long (<=4000)'; end if;

  if v_id is null then
    insert into public.clients (name, notes) values (btrim(v_name), p_payload->>'notes') returning id into v_id;
  else
    update public.clients set name = btrim(v_name), notes = p_payload->>'notes' where id = v_id;
    if not found then raise exception 'upsert_client: client % not found', v_id; end if;
  end if;
  perform public.log_activity(p_actor, 'crm.client_save', 'clients', v_id, coalesce(p_audit,'{}'::jsonb));
  return v_id;
end $$;

-- ── 4) upsert_deal: create or update a deal ──────────────────────────────────────────────────
create or replace function public.upsert_deal(p_payload jsonb, p_actor uuid, p_audit jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id        uuid := nullif(p_payload->>'id','')::uuid;
  v_client_id uuid := nullif(p_payload->>'client_id','')::uuid;
  v_owner_id  uuid := nullif(p_payload->>'owner_id','')::uuid;
  v_title     text := p_payload->>'title';
  v_stage     text := p_payload->>'stage';
  v_currency  text := coalesce(nullif(p_payload->>'currency',''),'USD');
  v_amount    numeric;
begin
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'upsert_deal: actor must be an active team member';
  end if;
  if exists (select 1 from jsonb_object_keys(p_payload) k where k not in ('id','client_id','title','stage','amount','currency','owner_id','notes')) then
    raise exception 'upsert_deal: unexpected key in payload';
  end if;
  if v_title is null or btrim(v_title) = '' or length(v_title) > 200 then raise exception 'upsert_deal: title required (<=200 chars)'; end if;
  if v_stage is null or v_stage not in ('lead','qualified','proposal','negotiation','won','lost') then raise exception 'upsert_deal: bad stage %', v_stage; end if;
  if length(v_currency) > 10 then raise exception 'upsert_deal: bad currency'; end if;
  if p_payload ? 'notes' and jsonb_typeof(p_payload->'notes') not in ('string','null') then raise exception 'upsert_deal: notes must be a string'; end if;
  -- amount: optional number >= 0 (null clears it)
  if p_payload ? 'amount' and jsonb_typeof(p_payload->'amount') not in ('number','null') then raise exception 'upsert_deal: amount must be a number'; end if;
  if jsonb_typeof(p_payload->'amount') = 'number' then
    v_amount := (p_payload->>'amount')::numeric;
    if v_amount < 0 or v_amount > 1e12 then raise exception 'upsert_deal: amount out of range'; end if;
  end if;
  if (p_payload->>'notes') is not null and length(p_payload->>'notes') > 4000 then raise exception 'upsert_deal: notes too long (<=4000)'; end if;
  -- referential checks (fail closed; FKs would catch too, but give clean messages)
  if v_client_id is not null and not exists (select 1 from public.clients where id = v_client_id) then raise exception 'upsert_deal: client % not found', v_client_id; end if;
  if v_owner_id is not null and not exists (select 1 from public.team_members where id = v_owner_id and active) then raise exception 'upsert_deal: owner must be an active team member'; end if;

  if v_id is null then
    insert into public.deals (client_id, title, stage, amount, currency, owner_id, notes)
      values (v_client_id, btrim(v_title), v_stage::public.deal_stage, v_amount, v_currency, v_owner_id, p_payload->>'notes')
      returning id into v_id;
  else
    update public.deals set
      client_id = v_client_id, title = btrim(v_title), stage = v_stage::public.deal_stage,
      amount = v_amount, currency = v_currency, owner_id = v_owner_id, notes = p_payload->>'notes'
      where id = v_id;
    if not found then raise exception 'upsert_deal: deal % not found', v_id; end if;
  end if;
  perform public.log_activity(p_actor, 'crm.deal_save', 'deals', v_id, coalesce(p_audit,'{}'::jsonb));
  return v_id;
end $$;

-- ── 5) link_document_deal: attach/detach a document to a deal ───────────────────────────────────
create or replace function public.link_document_deal(p_document_id uuid, p_deal_id uuid, p_actor uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'link_document_deal: actor must be an active team member';
  end if;
  if p_document_id is null or not exists (select 1 from public.documents where id = p_document_id) then raise exception 'link_document_deal: document not found'; end if;
  if p_deal_id is not null and not exists (select 1 from public.deals where id = p_deal_id) then raise exception 'link_document_deal: deal not found'; end if;
  update public.documents set deal_id = p_deal_id where id = p_document_id;
  perform public.log_activity(p_actor, 'crm.document_link', 'documents', p_document_id,
    jsonb_build_object('deal_id', coalesce(p_deal_id::text, 'null')));
end $$;

revoke execute on function public.upsert_client(jsonb, uuid, jsonb)        from public, anon, authenticated;
revoke execute on function public.upsert_deal(jsonb, uuid, jsonb)          from public, anon, authenticated;
revoke execute on function public.link_document_deal(uuid, uuid, uuid)     from public, anon, authenticated;
grant  execute on function public.upsert_client(jsonb, uuid, jsonb)        to service_role;
grant  execute on function public.upsert_deal(jsonb, uuid, jsonb)          to service_role;
grant  execute on function public.link_document_deal(uuid, uuid, uuid)     to service_role;
