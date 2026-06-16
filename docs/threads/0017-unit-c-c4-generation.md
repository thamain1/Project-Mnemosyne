# 0017 — Unit C (dashboard writes) → C4 (contract generation) arc

**Status:** 🟡 **OPEN — Unit C built, awaiting Aegis QC.** First authenticated browser WRITE path
(`/api/log-update`). · **Owner:** Atlas · **Opened:** 2026-06-16

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

### Aegis — (awaiting)
<!-- Aegis: pull, then append your review here. -->
