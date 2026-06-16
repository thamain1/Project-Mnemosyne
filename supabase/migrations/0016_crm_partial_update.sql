-- Mnemosyne — 0016: make upsert_client / upsert_deal PATCH-safe (partial update). Additive (CREATE OR REPLACE).
-- UNAPPLIED until applied with C5.1.
--
-- Fix (found by the C5.1 smoke): the 0015 UPDATE branch overwrote EVERY column from the payload, so a partial
-- update (e.g. a stage-move sending only {id, title, stage}) silently NULLed unsent fields (amount, owner, …).
-- The live UI resends the full row so it was masked, but the RPC must not lose data on a partial call.
-- Now: on UPDATE, each column changes ONLY if its key is present in the payload (present+null clears it;
-- absent keeps the existing value). INSERT behavior unchanged. Validation still runs on any present field.

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
  if p_payload ? 'name' and (jsonb_typeof(p_payload->'name') is distinct from 'string' or btrim(coalesce(v_name,'')) = '' or length(v_name) > 200) then
    raise exception 'upsert_client: name required (<=200 chars)';
  end if;
  if p_payload ? 'notes' and jsonb_typeof(p_payload->'notes') not in ('string','null') then raise exception 'upsert_client: notes must be a string'; end if;
  if (p_payload->>'notes') is not null and length(p_payload->>'notes') > 4000 then raise exception 'upsert_client: notes too long (<=4000)'; end if;

  if v_id is null then
    if not (p_payload ? 'name') or btrim(coalesce(v_name,'')) = '' then raise exception 'upsert_client: name required'; end if;
    insert into public.clients (name, notes) values (btrim(v_name), p_payload->>'notes') returning id into v_id;
  else
    update public.clients set
      name  = case when p_payload ? 'name'  then btrim(v_name)        else name  end,
      notes = case when p_payload ? 'notes' then p_payload->>'notes'  else notes end
      where id = v_id;
    if not found then raise exception 'upsert_client: client % not found', v_id; end if;
  end if;
  perform public.log_activity(p_actor, 'crm.client_save', 'clients', v_id, coalesce(p_audit,'{}'::jsonb));
  return v_id;
end $$;

create or replace function public.upsert_deal(p_payload jsonb, p_actor uuid, p_audit jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id        uuid := nullif(p_payload->>'id','')::uuid;
  v_client_id uuid := nullif(p_payload->>'client_id','')::uuid;
  v_owner_id  uuid := nullif(p_payload->>'owner_id','')::uuid;
  v_title     text := p_payload->>'title';
  v_stage     text := p_payload->>'stage';
  v_amount    numeric;
begin
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'upsert_deal: actor must be an active team member';
  end if;
  if exists (select 1 from jsonb_object_keys(p_payload) k where k not in ('id','client_id','title','stage','amount','currency','owner_id','notes')) then
    raise exception 'upsert_deal: unexpected key in payload';
  end if;
  -- validate any PRESENT field
  if p_payload ? 'title' and (jsonb_typeof(p_payload->'title') is distinct from 'string' or btrim(coalesce(v_title,'')) = '' or length(v_title) > 200) then raise exception 'upsert_deal: title required (<=200 chars)'; end if;
  if p_payload ? 'stage' and (v_stage is null or v_stage not in ('lead','qualified','proposal','negotiation','won','lost')) then raise exception 'upsert_deal: bad stage %', v_stage; end if;
  if p_payload ? 'currency' and length(coalesce(nullif(p_payload->>'currency',''),'USD')) > 10 then raise exception 'upsert_deal: bad currency'; end if;
  if p_payload ? 'notes' and jsonb_typeof(p_payload->'notes') not in ('string','null') then raise exception 'upsert_deal: notes must be a string'; end if;
  if p_payload ? 'amount' and jsonb_typeof(p_payload->'amount') not in ('number','null') then raise exception 'upsert_deal: amount must be a number'; end if;
  if jsonb_typeof(p_payload->'amount') = 'number' then
    v_amount := (p_payload->>'amount')::numeric;
    if v_amount < 0 or v_amount > 1e12 then raise exception 'upsert_deal: amount out of range'; end if;
  end if;
  if v_client_id is not null and not exists (select 1 from public.clients where id = v_client_id) then raise exception 'upsert_deal: client % not found', v_client_id; end if;
  if v_owner_id is not null and not exists (select 1 from public.team_members where id = v_owner_id and active) then raise exception 'upsert_deal: owner must be an active team member'; end if;

  if v_id is null then
    if not (p_payload ? 'title') or btrim(coalesce(v_title,'')) = '' then raise exception 'upsert_deal: title required'; end if;
    if not (p_payload ? 'stage') then raise exception 'upsert_deal: stage required'; end if;
    insert into public.deals (client_id, title, stage, amount, currency, owner_id, notes)
      values (v_client_id, btrim(v_title), v_stage::public.deal_stage, v_amount,
              coalesce(nullif(p_payload->>'currency',''),'USD'), v_owner_id, p_payload->>'notes')
      returning id into v_id;
  else
    -- PATCH: change a column only if its key is present in the payload
    update public.deals set
      client_id = case when p_payload ? 'client_id' then v_client_id                                          else client_id end,
      title     = case when p_payload ? 'title'     then btrim(v_title)                                       else title     end,
      stage     = case when p_payload ? 'stage'     then v_stage::public.deal_stage                           else stage     end,
      amount    = case when p_payload ? 'amount'    then v_amount                                             else amount    end,
      currency  = case when p_payload ? 'currency'  then coalesce(nullif(p_payload->>'currency',''),'USD')    else currency  end,
      owner_id  = case when p_payload ? 'owner_id'  then v_owner_id                                           else owner_id  end,
      notes     = case when p_payload ? 'notes'     then p_payload->>'notes'                                  else notes     end
      where id = v_id;
    if not found then raise exception 'upsert_deal: deal % not found', v_id; end if;
  end if;
  perform public.log_activity(p_actor, 'crm.deal_save', 'deals', v_id, coalesce(p_audit,'{}'::jsonb));
  return v_id;
end $$;
