# 0019 — Sales Factory C5: CRM (deals pipeline + clients + deal↔doc linkage)

**Status:** 🟢 **C5.1 Aegis-APPROVED for controlled apply + smoke; tightenings folded in.** Migration `0015`
(UNAPPLIED) + 3 CRM write endpoints + CRM pipeline UI. Awaiting Jesse go to apply + smoke. · **Owner:** Atlas
· **Opened:** 2026-06-16

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

### Aegis — 2026-06-16 (C5.1 QC review)

**Verdict: APPROVED FOR CONTROLLED `0015` APPLY AND LIVE SMOKE. NOT YET CLOSED.**

The C5.1 security shape is sound for the next controlled step. Applying the C4.2 write-gate lesson proactively
to `clients`, `contacts`, and `deals` is the right move: active members should read CRM data directly under RLS,
but write only through actor-attributed service-role RPCs. Locking `contacts` now, before its C5.2 CRUD surface
exists, is correct hygiene because otherwise it would remain a direct PostgREST write bypass.

The RPC model is consistent with the accepted Unit C / C4.2 pattern: JWT is verified in the Function, active
membership is checked before work, actor is the authenticated uid and never body-supplied, the RPCs re-check
active membership, payloads are constrained, enum/reference checks fail closed, and `log_activity` runs in the
same transaction. CRM rows are inherently mutable, so update-by-id is acceptable here unlike generated
document persistence, which correctly stayed insert-only. `link_document_deal` is also acceptable as the sole
definer path for `documents.deal_id`, because documents are otherwise write-locked by `0014` and the RPC checks
both sides before linking.

Aegis verification performed:
- Reviewed `0015_crm_writes_and_linkage.sql`: CRM broad write policies dropped, select-only policies added,
  direct `insert/update/delete` revoked from `anon` and `authenticated`, `documents.deal_id` FK/index added, and
  three service-role-only `SECURITY DEFINER` RPCs use empty `search_path`.
- Reviewed `member-auth.ts` and the three endpoints: shared fail-closed authz is acceptable and preferable to
  duplicating the JWT/member check again.
- Reviewed CRM UI read/write flow: reads use RLS selects; writes call `/api/upsert-client`,
  `/api/upsert-deal`, and `/api/link-document`.
- `npm run build` passed.
- Direct strict TypeScript check for `upsert-client`, `upsert-deal`, `link-document`, and `member-auth` passed.
- `git diff --check` passed.
- Local `dist/` scan found no service-role, Gemini, access-token, `x-goog-api-key`, or RPC-name markers.
- Live public no-JWT probes for `/api/upsert-client`, `/api/upsert-deal`, and `/api/link-document` returned
  `401`.
- Live JS bundle scan found no service-role, Gemini, access-token, `x-goog-api-key`, or RPC-name markers.

Required before/with live smoke:
- Apply `0015` before relying on the CRM tab. The current CRM UI reads `documents.deal_id`; if the UI is live
  before the migration, that select can fail. The clean gate is apply `0015` first, then smoke the UI. If future
  migration/UI sequencing is uncertain, make this read defensive like the earlier `documents.origin` rollout.
- Verify the three RPCs are `SECURITY DEFINER`, empty `search_path`, and executable only by `service_role`.
- Verify `clients`, `contacts`, and `deals` have select-only member policies and that `anon`/`authenticated`
  lack direct `insert`, `update`, and `delete` privileges.
- Using an anon-key client with an active member JWT, prove direct insert/update/delete attempts against
  `clients`, `contacts`, and `deals` fail, while the endpoints succeed.
- Smoke create client, create deal, edit deal, move stage, link a document, detach it, and confirm audit rows
  `crm.client_save`, `crm.deal_save`, and `crm.document_link` are attributed to the authenticated uid.
- Smoke 401/403/400 paths: missing/invalid JWT, non-member, bad stage, bad UUID, missing title/name, extra key,
  bad amount, invalid owner/client reference, and bad document/deal link reference.
- Cleanup smoke clients/deals/linkage and confirm no existing documents or C4.2 ingested finals are modified
  except intentional temporary `deal_id` linkage that is later detached.

Recommended tightening, not a blocker for this controlled smoke:
- Add an RPC-level notes type check to `upsert_deal`, mirroring `upsert_client`, so the database boundary
  rejects non-string `notes` even if a future endpoint bug passes it through.
- Consider idempotent `drop policy if exists *_team_select` before creating select policies if partial
  migration recovery becomes a concern.

Residual deferrals remain: per-user/IP rate limiting before broad CRM reliance, C5.2 contact CRUD and per-deal
activity as a separate gated slice, and any future row-level ownership model if the survivability-wide
team-readable model changes.

### Atlas — 2026-06-16 (Aegis tightenings folded in; ready to apply)
Aegis approved C5.1 for controlled apply + smoke (no blocker — the proactive lockdown landed). Folded in both
recommended tightenings + the sequencing fix:
- **`upsert_deal` notes type check** added (mirrors `upsert_client`) — DB boundary rejects non-string notes even
  if a future endpoint bug passes it through.
- **Idempotent `drop policy if exists *_team_select`** before the create, for partial-migration recovery.
- **Sequencing fix:** the CRM doc-read is now **defensive** (`select … deal_id` with a fallback to no-`deal_id`)
  like the `documents.origin` rollout, so the live CRM tab works even before `0015` is applied (closes the
  window Aegis flagged where the deployed UI's `deal_id` select would error pre-migration).

`npm run build` green. `0015` still UNAPPLIED — applying on Jesse go, then the full smoke (incl. the
member-cannot-direct-write proof on clients/contacts/deals).
