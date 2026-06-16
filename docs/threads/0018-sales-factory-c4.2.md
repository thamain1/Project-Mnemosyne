# 0018 — Sales Factory C4.2: persist + re-embed generated drafts

**Status:** 🟡 **OPEN — built, awaiting Aegis QC.** New migration `0013` (UNAPPLIED) + `/api/save-document`
+ the prohibited-content scanner Aegis required before persistence. · **Owner:** Atlas · **Opened:** 2026-06-16

**Topic:** Let a C4.1-generated MOU/SOW draft be **saved into the brain** as a `documents` row + re-embedded
chunks, so it appears in Documents browse / `/api/search-docs` / `/api/ask-docs`. This is the first
browser-initiated **document write** and the first time generated content is persisted, so it gets its own
security review (the arc lives in `0017`; Unit C + C4.1 are closed there). Builds on the Unit-C
actor=uid authed-write pattern + the C1/remember_memory persistence discipline.

---

### Atlas — 2026-06-16 (C4.2 for review)

**Prerequisite Aegis set in C4.1 — DONE:** the in-harness prohibited-content scan is now an **automated
server-side scanner** `functions/_lib/contract-scan.ts` (`scanContract`): vendor/product **brand names**
(conservative, unambiguous tokens only), **AI-disclosure phrasing** (disclosure phrasing only — NOT the topic
"artificial intelligence", so an AI-subject project isn't wrongly blocked), leftover assembly **markers**, and
high-signal **secret** patterns. Wired both ways:
- `/api/generate-contract`: runs after assembly → hits added to `warnings` + `scan_clean:false` (draft still
  returned, review-only; UI disables "Save to brain" when not clean).
- `/api/save-document`: runs before persistence → **REFUSE `422` with the hit list, no row written**.

**C4.2.1 — migration `0013_save_document_rpc.sql` (UNAPPLIED):**
- `alter documents add column origin text not null default 'ingested'` + check `in ('ingested','draft')`. The
  12 C1 finals become `'ingested'`; generated drafts are `'draft'`. **Lets `save_document` be INSERT-ONLY so a
  draft can never collide with / overwrite an ingested final.**
- `save_document(p_payload jsonb, p_actor uuid, p_audit jsonb)` — SECURITY DEFINER, empty `search_path`,
  **service_role-only**. Actor must be an ACTIVE team member (fail closed). Strict payload
  (`doc_type`/`title`/`extracted_text`/`chunks`; unexpected key → raise). Mirrors `remember_memory`'s chunk
  discipline: contiguous `chunk_index` from 0, non-empty content, **768-dim, unit-normalized** embedding,
  pinned `embedding_model='gemini-embedding-001'`, hard fan-out bound (≤64). **INSERTs a NEW row only**
  (`origin='draft'`, `created_by=actor`, sensitivity at the table default `restricted`) + its chunks +
  **atomic `log_activity('document.save_draft', …)`** in one transaction. No update/delete/overwrite path.

**C4.2.2 — `functions/api/save-document.ts`:** `POST` `{ doc_type:'mou'|'sow', title, markdown }` + member JWT.
Strict args (`additionalProperties:false`). Same fail-closed authz (JWT → active member). Then: **scan-gate
(422 if not clean)** → chunk (`8000/6000/500`, same as ingest-contracts) → embed each chunk
(`RETRIEVAL_DOCUMENT`, 768, normalized) → `save_document` RPC (actor = uid). Returns `{ id, chunks }` (201).
RPC validation errors surfaced as 400; others 502.

**C4.2.3 — UI:** Generate page gains **"Save to brain"** (disabled when `scan_clean===false`; success/blocked
messages). Documents page shows a **draft** badge (`origin==='draft'`) via a **defensive** select — it tries
`origin` and falls back without it, so the live Documents view does NOT break in the window before `0013` is
applied; the badge lights up once it is.

**Verified (build/static):** `npm run build` green; **all C4.2 Functions tsc-check clean**
(`es2022,webworker,dom`); **`dist/` leak scan clean** — no service-role/Gemini/`x-goog-api-key`/`save_document`/
`RETRIEVAL_DOCUMENT` markers in the client bundle; `/api/save-document` referenced; scanner + RPC live only in
the Function. **`0013` NOT applied** (gated on this QC + Jesse go).

**Questions for Aegis:**
1. **`save_document` boundary** — service_role-only, actor=uid active-member fail-closed, strict payload,
   `remember_memory`-grade chunk validation, **insert-only** (no upsert/overwrite), atomic audit. Sound for the
   first browser-initiated document write? Anything to tighten vs the blessed `remember_memory`/`log_activity`?
2. **`origin` provenance** — column + check + insert-only as the mechanism that keeps generated drafts from
   ever touching ingested finals. Sufficient, or do you want a separate table / stricter separation?
3. **Scanner as the persistence gate** — `422` refuse-on-not-clean before any write, same scan warns in
   generate. Categories/regex conservative enough (no false-positive blocks) yet sufficient as the backstop?
4. **Exposure** — saved drafts are `sensitivity='restricted'` = team-readable (same model as the C1 finals,
   Jesse-accepted) and become searchable via the existing endpoints. Confirm intended for C4.2?
5. **Re-save semantics** — insert-only means re-saving creates a new draft row (no dedupe). Acceptable for now,
   or add a uniqueness/versioning model? (C1 close-out already flagged durable doc uniqueness as future work.)
6. Standing deferrals: per-user rate limiting (now also an embedding cost) + audit records action+metadata only
   (no contract text) — agreed as pre-broad-rollout?

**Post-sign-off (gated on Jesse go):** apply `0013` → verify `save_document` def/ACL (service_role-only) +
`origin` column/check → live smoke: member JWT saves a generated MOU draft → `201` + a `documents` row with
`origin='draft'`, `created_by`=uid, chunks 768-dim/normalized, an `activity_log` `document.save_draft` row;
a draft carrying a planted brand/secret/marker → **422, no row**; missing/invalid JWT → 401, non-member → 403,
bad doc_type/oversize/extra key → 400; Documents shows the draft badge + it's findable via `/api/search-docs`;
cleanup the smoke row. Confirm no ingested final was modified.

### Aegis — (awaiting)
<!-- Aegis: pull, then append your C4.2 review here. -->
