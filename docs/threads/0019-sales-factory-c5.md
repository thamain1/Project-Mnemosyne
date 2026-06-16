# 0019 — Sales Factory C5: CRM (deals pipeline + clients + deal↔doc linkage)

**Status:** 🟡 **OPEN — C5.1 built, awaiting Aegis QC.** Migration `0015` (UNAPPLIED) + 3 CRM write endpoints +
CRM pipeline UI. · **Owner:** Atlas · **Opened:** 2026-06-16

**Topic:** The last sales-factory piece — a CRM. Clients/contacts/deals are scaffolded (RLS, `deal_stage`
enum) but empty. C5.1 delivers a **deals pipeline (kanban by stage) + clients CRUD + deal↔document linkage**;
contacts + per-deal activity deferred to C5.2. **Decisions (Jesse):** first slice = deals pipeline + clients;
linkage = add `documents.deal_id` FK (a doc belongs to one deal, a deal has many docs).

This is the first **multi-entity write** surface. It reuses Unit-C's actor=uid authed-write pattern and —
critically — **applies the C4.2 write-gate lesson (thread 0018) PROACTIVELY**: the CRM tables still had the
survivability-era `for all using(is_team_member())` policy + full `anon`/`authenticated` ins/upd/del grants
(verified live), so a member could bypass any endpoint and write rows directly via PostgREST. C5.1 closes that.

---

### Atlas — 2026-06-16 (C5.1 for review)

**C5.1.1 — migration `0015_crm_writes_and_linkage.sql` (UNAPPLIED):**
- **Lockdown:** drop `clients_team_all` / `contacts_team_all` / `deals_team_all`; replace with team-readable
  **SELECT-only** policies; **revoke `insert,update,delete`** on all three from `anon` + `authenticated`.
  (Contacts is locked now too even though its CRUD lands in C5.2 — correct hygiene; C5.2 adds its RPC.)
- **Linkage:** `documents.deal_id uuid references deals(id) on delete set null` + index. Set only via the
  service-role `link_document_deal` (documents are write-locked by `0014`).
- **Write RPCs** — all SECURITY DEFINER, empty `search_path`, **service_role-only**, actor must be an ACTIVE
  team member (fail closed), strict payload (`additionalProperties` → raise), **atomic `log_activity` audit**:
  - `upsert_client(p_payload, p_actor, p_audit)` — insert (no id) / update (id must exist). name req ≤200;
    notes ≤4000. → `crm.client_save`.
  - `upsert_deal(p_payload, p_actor, p_audit)` — insert/update. title req ≤200; **stage validated against the
    6-value enum**; amount optional number 0..1e12; currency ≤10 (default USD); **client_id must exist**,
    **owner_id must be an active member**; notes ≤4000. → `crm.deal_save`.
  - `link_document_deal(p_document_id, p_deal_id, p_actor)` — attach (deal_id) / detach (null); both ids
    existence-checked. → `crm.document_link`.

**C5.1.2 — endpoints** (`functions/api/upsert-client.ts`, `upsert-deal.ts`, `link-document.ts`): each JWT →
active member → RPC (actor = **authenticated uid**, never the body). Shared helper
`functions/_lib/member-auth.ts` (`requireMember` fail-closed env+JWT+member check; `parseStrict`
additionalProperties:false; `isUuid`). Strict arg validation mirrors the RPC bounds for clean 400s; the RPC is
authoritative. RPC validation errors → 400; others → 502. 201 on create, 200 on update.

**C5.1.3 — `src/pages/CRM.tsx` + "CRM" tab:** kanban board (6 stage columns, deal cards grouped by stage with
a per-card stage-move `select` → `upsert-deal`; column counts + open-pipeline value), clients grid, create/edit
**deal** + **client** modals, and a **deal detail** modal showing linked documents + an attach/detach picker
(`link-document`). All reads via the existing RLS team-readable `select`; all writes via the endpoints.

**Verified (build/static):** `npm run build` green (CRM bundled); **all C5 Functions tsc-check clean**
(`--strict`, `es2022,webworker,dom`); **`dist/` leak scan clean** — no service-role/Gemini/`x-goog-api-key`/RPC-
name markers; all three endpoints referenced. **`0015` NOT applied** (gated on QC + Jesse go).

**Questions for Aegis:**
1. **Proactive lockdown** — same fix as `0014`, now on clients/contacts/deals (SELECT-only + revoke
   ins/upd/del). Locking **contacts** now (CRUD comes in C5.2) — agree that's correct hygiene vs leaving it open?
2. **upsert RPCs** — actor=uid active-member, strict payload, enum/refs validated, insert-or-update by id,
   atomic audit. Sound, and consistent with the blessed `remember_memory`/`save_document` shape? Any concern
   with update-by-id (vs the insert-only doc model — CRM rows are inherently mutable, so update is intended)?
2a. **`link_document_deal`** writes `documents.deal_id` from a member-initiated call — documents are otherwise
    write-locked (0014); this definer RPC is the only path and existence-checks both ids. OK?
3. **Exposure** — clients/deals are `team`/`restricted` sensitivity = team-readable (consistent with the rest of
   the survivability model). Confirm intended for C5.1.
4. **Shared helper** `member-auth.ts` (one fail-closed authz path reused by 3 endpoints) — good, or prefer
   per-endpoint inlining like the earlier units?
5. Standing deferrals: per-user rate limiting; audit is action+safe-metadata only (no notes/PII text) — agreed
   as pre-broad-rollout?

**Post-sign-off (gated on Jesse go):** apply `0015` → verify the 3 RPCs (definer/empty search_path/service_role-
only), `documents.deal_id` FK, and **clients/contacts/deals SELECT-only + anon/authenticated lack ins/upd/del**
→ live smoke: member JWT creates a client + a deal (201), edits the deal (200), moves stage, links a generated
draft to the deal + detaches; **prove an authenticated member CANNOT direct insert/update/delete clients,
contacts, or deals (expect `42501`)** while the endpoints succeed; audit rows `crm.client_save`/`crm.deal_save`/
`crm.document_link` with actor=uid; 401/403/400 paths (incl. bad stage, bad uuid, missing title, extra key);
cleanup the smoke rows.

### Aegis — (awaiting)
<!-- Aegis: pull, then append your C5.1 review here. -->
