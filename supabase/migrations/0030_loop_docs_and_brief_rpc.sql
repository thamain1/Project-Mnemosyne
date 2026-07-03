-- Mnemosyne — 0030: P2-LOOP v1 (thread 0033). Additive. UNAPPLIED until Aegis post-build QC + Jesse
-- apply-go. Deliberately tiny — this unit is mostly code + a runbook; the loop's heavy machinery
-- (bridge, client_360, hybrid recall, CRM fields, doc factory, hosted MCP) shipped in 0027-0029.
--
-- Part A: `upsert_client_brief` — the ONE narrow write path a machine uses to persist prospect
-- research as a client-linked memory (client_id set at birth, versioned on re-run, audited in the
-- same transaction). Concurrency is DELIBERATELY SERIALIZED (not optimistic): a transaction-scoped
-- advisory lock keyed on the client id — same house pattern as 0010's secrets-vault lock
-- (pg_advisory_xact_lock(hashtext('p4w-secret:...'))) — is taken BEFORE the existence check, so two
-- concurrent first-create calls for the SAME client can never both observe "not exists" and race the
-- unique memory_entries.name constraint (the exact gap Aegis's binding re-review correction called
-- out: `select ... for update` alone only serializes the UPDATE path, not first CREATE). The second
-- concurrent caller simply blocks on the lock, then — once it acquires it — sees the row the first
-- caller just created and takes the normal UPDATE/version branch. One row, no unhandled 23505,
-- coherent final body, exactly the version/audit behavior of a normal re-run.
--
-- `source_path = null` is a NEW, distinct provenance shape (Aegis "Additional Build Notes"): NOT
-- `mcp/<slug>` (remember_memory's shape) and NOT `memory/<file>.md` (ingest_memory_entry's shape).
-- Both of those RPCs' existing ON CONFLICT ... WHERE ownership guards
-- (`where source_path ~ '^mcp/'` / `where source_path ~ '^memory/'`) ALREADY structurally exclude a
-- NULL source_path row — `null ~ '^mcp/'` evaluates to NULL, which a WHERE clause treats as false, so
-- the conflicting row is never updated and both RPCs raise their existing "collides with an entry
-- this tool does not own" exception. No change was needed to either RPC to enforce this; it is a
-- verified property of the existing code, not a new guard, and is proven by smoke.
--
-- Part B: `doc_kind` gains 'case-study' + 'client-brief' (additive enum values); `save_rendered_document`
-- extended to accept both. The `client-brief` audience-internal-only posture lives in APPLICATION CODE
-- (functions/_lib/brand-template.ts + src/lib/docTypes.ts `allowedAudiences`, enforced in
-- render-document.ts / save-rendered-document.ts BEFORE the governance scan) — not in SQL, because the
-- catalog/audience model doesn't exist in this database at all; it's a TypeScript-only concept.

-- ═══════════════════════════════════ PART A — upsert_client_brief ═══════════════════════════════════

create or replace function public.upsert_client_brief(
  p_actor uuid,
  p_client_id uuid,
  p_deal_id uuid,
  p_title text,
  p_body text,
  p_embedding public.vector(768),
  p_embedding_model text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_client_name text;
  v_client_slug text;
  v_name        text;
  v_entry       public.memory_entries%rowtype;
  v_version     int := 0;
  v_refreshed   boolean;
  v_norm        double precision;
begin
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'upsert_client_brief: actor must be an active team member';
  end if;
  if p_title is null or btrim(p_title) = '' or length(p_title) > 200 then
    raise exception 'upsert_client_brief: title required (<=200 chars)';
  end if;
  if p_body is null or btrim(p_body) = '' or length(p_body) > 24000 then
    raise exception 'upsert_client_brief: body required (<=24000 chars)';
  end if;
  if p_embedding_model is distinct from 'gemini-embedding-001' then raise exception 'upsert_client_brief: bad embedding_model'; end if;
  if p_embedding is null then raise exception 'upsert_client_brief: embedding required'; end if;
  if public.vector_dims(p_embedding) <> 768 then raise exception 'upsert_client_brief: embedding not 768-dim'; end if;
  v_norm := public.vector_norm(p_embedding);
  if v_norm = 0 or abs(v_norm - 1) > 1e-3 then raise exception 'upsert_client_brief: embedding not unit-normalized (norm=%)', v_norm; end if;

  select name into v_client_name from public.clients where id = p_client_id;
  if not found then raise exception 'upsert_client_brief: client % not found', p_client_id; end if;
  if p_deal_id is not null and not exists (select 1 from public.deals where id = p_deal_id and client_id = p_client_id) then
    raise exception 'upsert_client_brief: deal % does not belong to client %', p_deal_id, p_client_id;
  end if;

  -- deterministic, collision-proof name: client-brief-<slug<=50>-<id8> (worst case 13+50+1+8 = 72 <= 80)
  v_client_slug := trim(both '-' from regexp_replace(lower(v_client_name), '[^a-z0-9]+', '-', 'g'));
  if v_client_slug = '' then v_client_slug := 'client'; end if;
  v_name := 'client-brief-' || trim(trailing '-' from left(v_client_slug, 50)) || '-' || left(p_client_id::text, 8);

  -- SERIALIZE BEFORE the existence check (Aegis binding correction) — a transaction-scoped advisory
  -- lock keyed on the client id. Released automatically at transaction end (commit or rollback); no
  -- explicit unlock needed, matching the 0010 precedent.
  perform pg_advisory_xact_lock(hashtext('mnemosyne-client-brief:' || p_client_id::text));

  select * into v_entry from public.memory_entries where name = v_name for update;
  if found then
    v_refreshed := true;
    select coalesce(max(version_no), 0) + 1 into v_version from public.memory_versions where entry_id = v_entry.id;
    insert into public.memory_versions (entry_id, version_no, name, kind, title, body, links, source_path, sensitivity, edited_by, change_reason)
    values (v_entry.id, v_version, v_entry.name, v_entry.kind, v_entry.title, v_entry.body, v_entry.links, v_entry.source_path, v_entry.sensitivity, p_actor, 'prospect-research refresh');

    update public.memory_entries set
      title = p_title, body = p_body, embedding_model = p_embedding_model, embedding = p_embedding,
      client_id = p_client_id, deal_id = p_deal_id, updated_at = now()
      where id = v_entry.id;
  else
    v_refreshed := false;
    v_version := 0;
    insert into public.memory_entries (name, kind, title, body, links, source_path, embedding_model, embedding, client_id, deal_id)
    values (v_name, 'reference'::public.memory_kind, p_title, p_body, '{}', null, p_embedding_model, p_embedding, p_client_id, p_deal_id);
  end if;

  perform public.log_activity(p_actor, 'agent.client_brief', 'clients', p_client_id,
    jsonb_build_object('memory_name', v_name, 'title', p_title, 'refreshed', v_refreshed, 'deal_id', p_deal_id::text));

  return jsonb_build_object('name', v_name, 'refreshed', v_refreshed, 'version_no', v_version);
end $$;

revoke execute on function public.upsert_client_brief(uuid, uuid, uuid, text, text, public.vector, text) from public, anon, authenticated;
grant  execute on function public.upsert_client_brief(uuid, uuid, uuid, text, text, public.vector, text) to service_role;

-- ═══════════════════════════════════ PART B — doc-type catalog additions ════════════════════════════

alter type public.doc_kind add value if not exists 'case-study';
alter type public.doc_kind add value if not exists 'client-brief';

-- save_rendered_document: byte-for-byte identical to 0022 except the doc_type allow-list gains the
-- two new types. The audience-internal-only enforcement for 'client-brief' happens in application
-- code (render-document.ts / save-rendered-document.ts), not here — this RPC's own `audience` check
-- (client/internal/null) is unchanged and is not the structural boundary for that rule.
create or replace function public.save_rendered_document(p_payload jsonb, p_actor uuid, p_audit jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id        uuid;
  v_doc_type  text := p_payload->>'doc_type';
  v_title     text := p_payload->>'title';
  v_path      text := p_payload->>'storage_path';
  v_md        text := p_payload->>'markdown';
  v_audience  text := p_payload->>'audience';
  v_policy    text := p_payload->>'policy';
  v_deal      text := p_payload->>'deal_id';
  v_deal_id   uuid;
begin
  if p_actor is null or not exists (select 1 from public.team_members where id = p_actor and active) then
    raise exception 'save_rendered_document: actor must be an active team member';
  end if;
  if exists (select 1 from jsonb_object_keys(p_payload) k
             where k not in ('id','doc_type','title','storage_path','markdown','audience','policy','deal_id')) then
    raise exception 'save_rendered_document: unexpected key in payload';
  end if;
  begin v_id := (p_payload->>'id')::uuid; exception when others then raise exception 'save_rendered_document: id must be a uuid'; end;
  if v_id is null then raise exception 'save_rendered_document: id required'; end if;
  if exists (select 1 from public.documents where id = v_id) then raise exception 'save_rendered_document: id % already exists', v_id; end if;
  if v_doc_type is null or v_doc_type not in
     ('mou','sow','invoice','proposal','change-order','white-paper','use-case','capabilities-brief','exec-briefing','case-study','client-brief') then
    raise exception 'save_rendered_document: bad doc_type %', v_doc_type;
  end if;
  if v_title is null or v_title = '' or length(v_title) > 300 then raise exception 'save_rendered_document: bad title'; end if;
  if v_path is null or v_path <> 'rendered/' || v_id::text || '/v1.pdf' then
    raise exception 'save_rendered_document: storage_path must be rendered/<id>/v1.pdf';
  end if;
  if v_md is null or v_md = '' or length(v_md) > 200000 then raise exception 'save_rendered_document: markdown 1..200000 chars'; end if;
  if v_audience is not null and v_audience not in ('client','internal') then raise exception 'save_rendered_document: bad audience'; end if;
  if v_deal is not null and v_deal <> '' then
    begin v_deal_id := v_deal::uuid; exception when others then raise exception 'save_rendered_document: deal_id not a uuid'; end;
    if not exists (select 1 from public.deals where id = v_deal_id) then raise exception 'save_rendered_document: deal_id % not found', v_deal_id; end if;
  end if;

  insert into public.documents (id, doc_type, title, storage_path, extracted_text, origin, deal_id, created_by)
  values (v_id, v_doc_type::public.doc_kind, v_title, v_path, v_md, 'rendered', v_deal_id, p_actor);

  insert into public.document_versions (document_id, version_no, doc_type, title, storage_path, markdown, audience, policy, deal_id, edited_by, change_reason)
  values (v_id, 1, v_doc_type::public.doc_kind, v_title, v_path, v_md, v_audience, v_policy, v_deal_id, p_actor, nullif(p_audit->>'change_reason',''));

  perform public.log_activity(p_actor, 'document.render_save', 'documents', v_id, coalesce(p_audit, '{}'::jsonb));
  return v_id;
end $$;

revoke execute on function public.save_rendered_document(jsonb, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.save_rendered_document(jsonb, uuid, jsonb) to service_role;
