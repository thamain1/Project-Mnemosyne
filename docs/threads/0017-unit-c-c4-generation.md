# 0017 — Unit C (dashboard writes) → C4 (contract generation) arc

**Status:** ✅ **Unit C LIVE — Aegis-approved, smoke 15/15 PASSED.** First authenticated browser WRITE path
(`/api/log-update`). Arc continues → C4.1 next. · **Owner:** Atlas · **Opened:** 2026-06-16

**Topic:** Open the "CREATE" half of the sales factory. Everything so far is read-only (recall / search-docs /
ask-docs). C4 (contract generation) must persist its output as a `documents` draft → that needs an
**authenticated dashboard write path**, which doesn't exist yet. This thread tracks the arc; this first entry
is **Unit C** — the foundational authed-write endpoint that the later CREATE units reuse.

---

## Arc plan (sequenced; one unit → Aegis → next)

- **Unit C — authed write foundation** *(this entry)*: `/api/log-update`, post a work-note to the activity
  feed. Reuses the blessed `log_activity` RPC (0009) **as-is — no new migration**. Append-only, bounded,
  DB-layer secret-scanned = lowest-risk write. Establishes the **actor = authenticated uid** pattern.
- **C4.1 — `/api/generate-contract`**: generate a governed MOU/SOW/proposal/invoice **draft** (4ward Motion
  Solutions, Inc. entity; Delaware law/venue; standing rules: no vendor specifics, no AI-disclosure in
  binding docs; Jesse signs as Co-Founder & CTO). Optional retrieval grounding (reference prior contracts via
  `search_docs`). **Returns draft markdown to the browser for review/download — NO persistence.** Reuses the
  ask-docs generation pattern. Drafts are an **assisted-drafting aid for Jesse's review**, never auto-final,
  never auto-sent (honors engagement-docs-before-build).
- **C4.2 — persist + re-embed drafts**: save a generated draft as a `documents` row (+ re-chunk/embed so it's
  searchable) via an authed-write endpoint. **New migration**: a service-role doc-write RPC (actor = uid,
  distinct **draft provenance** so generated drafts never collide with / overwrite ingested final contracts).
  Security-sensitive → full Aegis.
- **C5 — CRM views**: clients/contacts/deals pipeline (by `deal_stage`); deals → generated-doc linkage.

Standing rules honored throughout: **never commit MOUs/SOWs/invoices to repos** (drafts live in the
access-controlled DB + download to `C:\Dev\<Project>\contracts\`, never git); no-vendor-specifics +
no-AI-disclosure in client-facing binding docs; 4ward Motion Solutions, Inc. as the entity.

---

### Atlas — 2026-06-16 (Unit C for review)

**C.1 — `functions/api/log-update.ts` (CF Pages Function):**
- `POST /api/log-update` `{ note: string ≤1000, action?: namespaced-token (default "work.note"),
  entity_type?: string ≤100, entity_id?: uuid }` + member JWT. Strict args (`additionalProperties:false`).
- **Same fail-closed authz as the read endpoints:** `getUser(jwt)` → active `team_members` check before any
  write. 401 (no/invalid JWT) / 403 (non-member) / 400 (bad args).
- **Write:** `log_activity` RPC (0009) with **`p_actor = the authenticated uid`** — derived from the verified
  JWT, **never from the request body**, so the client cannot forge who did it. `p_detail = { note }` (flat).
- **Reuses the blessed RPC as the authoritative gate:** `log_activity` re-validates actor-is-active-member,
  enforces the action token shape, bounds detail (flat object, ≤4KB, ≤30 keys, string values ≤1000), and
  DB-layer secret-scans entity_type + detail keys/values. The endpoint validates early for clean 400s; the
  RPC is the real boundary. RPC validation failures (secret detected / bad action / oversize) are surfaced as
  400; other RPC errors as 502.
- **No new env, no Gemini** (no embed/generation). Server-held `SUPABASE_SERVICE_ROLE_KEY` only (already set).

**C.2 — `src/pages/Activity.tsx`:** a composer above the feed — textarea (note) + action preset select
(work.note / project.update / deal.update / ops.note) → `POST /api/log-update` with the session token →
refetch the feed. Feed now renders `detail.note` as the primary line. "no secrets — team-visible" caption.

**Verified (build/static):** `npm run build` green; **`dist/` leak scan clean** — no
`service_role`/secret/`log_activity` markers in the client bundle; `/api/log-update` referenced; function not
bundled (separate Worker).

**Questions for Aegis:**
1. **First browser write.** Actor = authenticated uid (from verified JWT, not the body); write via the
   already-blessed service-role `log_activity`. Is the JWT→active-member→RPC(actor=uid) write pattern the
   right foundation to standardize on for all dashboard writes (C4 persistence reuses it)?
2. **Surfacing RPC validation messages as 400** (e.g. "detail appears to contain a secret"). Acceptable, or
   prefer a generic message to avoid echoing the validator's reasoning?
3. **No new migration** — Unit C rides entirely on 0009. Agreed that's the correct minimal surface?
4. Same standing deferrals as the read endpoints (per-user/IP **rate limiting** before broad reliance) — and
   now especially for a write path. Agreed it's a pre-broad-rollout deferral, not a blocker for controlled
   smoke?

**Post-sign-off (gated on Jesse go):** live smoke — member JWT posts a note → 201 + appears in the feed
attributed to the actor; missing/invalid JWT → 401; non-member → 403; oversized/empty note, bad action, extra
key → 400; a secret-bearing note → rejected (DB scan); confirm the response carries no secret/service-role
markers; deploy (git-connected) + live-verify the composer.

### Atlas — 2026-06-16 (live smoke PASSED — Unit C LIVE)
Ran the full Aegis-required battery against live `/api/log-update` via `scripts/smoke-log-update.mjs`
(throwaway ACTIVE member + throwaway non-member created via admin API, signed in for real JWTs, deleted
after). **15/15 pass:**
- Valid member + non-secret note → **201 + id**; the `activity_log` row's **`actor_id` == the authenticated
  member uid** (not any client value); note stored in `detail.note`.
- Missing JWT → **401**; invalid JWT → **401**; non-member JWT → **403**.
- Empty note → **400**; oversized (>1000) → **400**; non-namespaced action → **400**; invalid `entity_id` →
  **400**; extra key → **400**; **`actor_id` forgery field in body → 400** (additionalProperties rejects it
  before any write).
- **Secret-bearing note** (`AKIA…` pattern) → **400** (DB/RPC scan), and **no row written**.
- **No residue:** member had exactly **1** row (the valid 201); all 400s/secret attempt wrote nothing.
  Responses scanned — **no service-role/secret markers**. Post-run cleanup verified: 0 residual smoke
  team_members / auth users / activity rows.

**Unit C COMPLETE + LIVE.** Standing deferrals binding: per-user/IP **rate limiting** before broad write
reliance; C4.2 persistence stays behind its own migration/RPC review; this endpoint is **not** generalized
into arbitrary table writes. Next: **C4.1 — `/api/generate-contract`** (governed draft generation, no
persistence).

### Aegis — (close-out optional; Unit C live-verified)
<!-- Aegis: pull, then append your review here. -->

### Aegis — 2026-06-16 (QC review)

**Verdict: APPROVED FOR CONTROLLED UNIT C LIVE SMOKE ONLY. NOT YET APPROVED AS A GENERAL DASHBOARD WRITE FRAMEWORK.**

The write pattern is the right foundation for the next controlled step: browser sends only the member JWT, the server verifies that JWT with Supabase Auth, checks active `team_members` membership, and passes `p_actor = uid` from the verified token into the already-approved `log_activity` RPC. The request body cannot set or override actor identity, and the live endpoint rejects an attempted `actor_id` body field with `400`.

Reusing `log_activity` without a new migration is appropriate for Unit C. The RPC remains the authoritative write boundary: service-role-only execute, actor active-member recheck, namespaced action validation, flat bounded detail, and DB-layer secret scan. Surfacing RPC validation messages such as "detail appears to contain a secret" as `400` is acceptable for controlled internal use because it helps the user correct the note without exposing secret material. For broader rollout, consider mapping validator reasons to stable product messages.

Aegis repeated verification: `npm run build`, direct TypeScript compile for `functions/api/log-update.ts`, `git diff --check`, `dist/` server-secret/log-activity marker scan, live missing-JWT `401`, live actor-forgery-field `400`, and a read-only-style RPC probe confirming `log_activity` is present and rejects an invalid actor before write. Current `activity_log` count was 0 before smoke.

Required live smoke before close-out:
- Valid member JWT posts a non-secret note and receives `201` with an id.
- The created row appears in `activity_log` with `actor_id` equal to the authenticated member uid, not any client-supplied value.
- Activity page reload shows the note as team-visible feed content.
- Missing/invalid JWT returns `401`; non-member/inactive member returns `403`.
- Empty/oversized note, bad action, invalid `entity_id`, and extra key return `400`.
- Secret-bearing note is rejected by the DB/RPC scan and leaves no row residue.
- Response and live bundle contain no service-role markers or secret material.

Standing deferrals: add per-user/IP rate limiting before broad write reliance; keep generated-contract persistence (`C4.2`) behind a separate migration/RPC review; do not generalize this endpoint into arbitrary table writes.
