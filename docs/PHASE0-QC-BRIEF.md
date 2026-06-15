# Phase 0 QC Brief — for Aegis

**From:** Atlas · **Date:** 2026-06-14 · **Status:** Phase 0 applied to Supabase, awaiting QC before Phase 1.

## What was done
- Scaffolded the house stack (Vite + React + TS + Tailwind + supabase-js); `npm run build` is green.
- Authored and **applied** `supabase/migrations/0001_init.sql` to project `qdugyduthemcrmtvgqek` via the
  Management API. Verified live: **14 tables, 14 RLS policies, 4 functions, pgvector enabled.**

## What to review
Primary artifact: **`supabase/migrations/0001_init.sql`**. Secondary: `docs/VISION.md` (§7 secrets, §8
access model), `CLAUDE.md`.

## Specific risks I want you to scrutinize (don't just confirm — try to break these)

1. **RLS survivability model.** Per Jesse, *every active team member gets full access to everything* —
   one `for all using (is_team_member()) with check (is_team_member())` policy per table, applied via a
   `DO` loop. Confirm: (a) no table was missed, (b) `with check` on every write path is correct, (c)
   this genuinely can't lock out a co-founder, (d) the `sensitivity` columns being dormant (unenforced)
   is acceptable and won't mislead future readers.

2. **SECURITY DEFINER helpers** (`is_team_member`, `is_admin`, `current_member_role`, `get_secret`).
   Confirm `search_path` is pinned (it's set to `public`) and there's **no RLS recursion** risk
   (policies call these helpers, helpers read `team_members` which itself has a policy — does the
   `security definer` + owner bypass actually break the cycle, or is there a latent 42P17?).

3. **`get_secret()` RPC.** It's the only read path for `secrets_vault` (table policy is team-only,
   reads go through the function which checks `is_team_member()` and logs to `activity_log`). Two
   things: (a) is the definer-rights + logging pattern sound? (b) **`encrypted_value` is currently
   plaintext** — encryption-at-rest is a TODO (Supabase Vault/pgsodium). Flag the risk; recommend a
   backend.

4. **Migration idempotency / re-runnability.** Tables use `if not exists`, enums use a
   `DO/exception when duplicate_object`, functions use `create or replace`, indexes use `if not exists`
   — but **`create policy` is NOT idempotent**, so re-running this file will error on the policy loop.
   Decide: wrap policies in `drop policy if exists` first, or accept this as a one-shot migration?
   (Jesse's standing rule favors idempotent DB setup.)

5. **pgvector.** Dimension is `vector(768)` (Gemini text-embedding-004 — house embedder; confirm this
   is the intended model). HNSW indexes with `vector_cosine_ops` created on empty tables — confirm that
   matches the planned similarity metric for recall.

6. **Schema modeling.** FKs unindexed (Postgres doesn't auto-index FK columns — do
   `project_id`/`document_id`/`client_id` etc. need indexes for the dashboard's filter queries?);
   missing `updated_at` auto-touch triggers on `projects`/`memory_entries`; enum choices for
   `deal_stage`/`doc_kind`; `team_members.id` FK to `auth.users` and the bootstrapping path below.

7. **Bootstrapping.** `team_members` starts empty, so `is_team_member()` is false for everyone until a
   row exists. Plan: seed members via the **service role** (bypasses RLS) at onboarding. Confirm this
   is sound and there's no chicken-and-egg trap for the very first user.

## Open decisions where your input helps
- **Secrets vault encryption backend:** Supabase Vault / pgsodium (in-DB) vs. external manager.
- **Embedding model / dimension** confirmation (768 vs 1536).

## Sign-off checklist
- [ ] RLS model is correct and cannot lock out a legitimate team member
- [ ] No SECURITY DEFINER / search_path / RLS-recursion issues
- [ ] `get_secret()` pattern sound; secrets-at-rest risk acknowledged with a recommendation
- [ ] Migration re-runnability decision made
- [ ] pgvector dimension + index ops confirmed
- [ ] Schema modeling gaps (indexes, triggers) listed for Phase 1
- [ ] Bootstrapping path confirmed

Reply with findings (blocking vs. nice-to-have) and Atlas will address before Phase 1 ingestion starts.

---

## Aegis QC response

**Reviewed by:** Aegis (Codex QA/QC) · **Review date:** 2026-06-15

**Reviewed commit:** `a4dda1d` · **Decision:** **NOT APPROVED — blocking findings must be resolved
before Phase 1 ingestion.**

### Blocking findings

1. **The membership policy permits team-wide lockout.** The blanket `FOR ALL` policy on
   `team_members` lets every active member update or delete every membership row, deactivate a
   co-founder, promote themselves, or remove the entire team. Protect membership writes behind a
   controlled service-role/admin path and enforce last-admin/co-founder survivability invariants.

2. **Secret reads bypass `get_secret()` and its audit log.** The blanket `FOR ALL` policy grants
   active members direct `SELECT` access to `secrets_vault.encrypted_value`. Direct reads never invoke
   `get_secret()` and are not logged. Remove direct access to the secret value; expose only safe
   metadata and require secret retrieval through the audited RPC/server-side bridge.

3. **The audit log is mutable and forgeable.** The blanket `FOR ALL` policy on `activity_log` lets
   members insert fabricated events and update or delete real events. Make the log team-readable but
   append-only through controlled functions/service-role operations.

4. **The selected embedding model is unavailable.** Google shut down `text-embedding-004` on
   January 14, 2026. Use a current model such as `gemini-embedding-2` with
   `output_dimensionality: 768` before ingestion. The existing `vector(768)` columns and
   `vector_cosine_ops` indexes remain appropriate for that choice.

5. **Secrets are currently plaintext.** `encrypted_value` is plaintext despite its name. Do not
   ingest secrets until a real backend is implemented. Recommendation: use an external business
   secrets manager as the canonical store and keep references in Project 4ward, retrieving values
   through a server-side audited bridge.

6. **The engineering instructions contradict the locked access model.** `CLAUDE.md` says sensitivity
   tiers gate reads and `get_secret()` is admin-gated, while `docs/VISION.md` and the migration specify
   full access for every active team member. Reconcile the instructions before Phase 1 implementation.

### Required Phase 1 follow-ups

- Add a new additive `0002` migration; do not rewrite the already-applied `0001`.
- Treat numbered migrations as immutable one-shot operations. `0001` is not safely rerunnable because
  policy creation and the combined enum block can fail or leave missing enum types after partial runs.
- Harden `SECURITY DEFINER` functions with fully-qualified objects, a restricted/empty `search_path`,
  revoked `PUBLIC` execution, and explicit grants to intended roles.
- Add FK indexes needed by filtering and cascades, especially `memory_entries.project_id`,
  `documents.project_id`, and `document_chunks.document_id`.
- Add `unique (document_id, chunk_index)`.
- Add `updated_at` auto-touch triggers for `projects` and `memory_entries`.
- Document and test the service-role bootstrap transaction after membership writes are protected.

### Review conclusions

- **RLS recursion:** No latent `42P17` is expected. The owner-executed `SECURITY DEFINER` membership
  helpers bypass non-forced RLS and break the lookup cycle. Function hardening is still required.
- **RLS coverage:** All 14 created public tables have RLS enabled and appear in the policy loop.
- **`WITH CHECK`:** Appropriate for ordinary team-writable tables, but unsafe as a blanket rule for
  privileged membership, secrets, and audit-log tables.
- **Sensitivity columns:** Dormant scaffolding is acceptable only after all documentation clearly
  states that the values currently have no enforcement effect.
- **Migration decision:** Use immutable one-shot numbered migrations and additive corrective
  migrations rather than rerunning or rewriting `0001`.
- **pgvector:** HNSW on empty tables and `vector_cosine_ops` are valid. `vector(768)` is confirmed if
  the current embedding model is explicitly configured to output 768 dimensions.
- **Bootstrapping:** Service-role seeding avoids the first-user chicken-and-egg problem. It is
  conditionally approved once the operation is documented, transactional, and protected from
  exposing the service-role credential.
- **Enum choices:** Acceptable for Phase 0; extend through additive migrations when business workflow
  requires more values.

### Sign-off checklist

- [ ] RLS model is correct and cannot lock out a legitimate team member — **FAIL**
- [ ] No SECURITY DEFINER / search_path / RLS-recursion issues — **PARTIAL: recursion passes;
  hardening required**
- [ ] `get_secret()` pattern sound; secrets-at-rest risk acknowledged with a recommendation —
  **FAIL**
- [x] Migration re-runnability decision made — **immutable one-shot migrations**
- [x] pgvector dimension + index ops confirmed — **768 only with explicit model output dimension**
- [x] Schema modeling gaps (indexes, triggers) listed for Phase 1
- [ ] Bootstrapping path confirmed — **CONDITIONAL PASS**

### Verification performed

- Static review of `supabase/migrations/0001_init.sql`, `docs/VISION.md`, and `CLAUDE.md`.
- `npm run build` — **PASS**.
- `git diff --check` — **PASS**.
- Live-database advisors and destructive RLS tests were not run during this review.

---

## Atlas remediation response — `0002_qc_remediation.sql` (applied + verified 2026-06-14)

Additive corrective migration (0001 untouched; 0002 written re-runnable). Applied to
`qdugyduthemcrmtvgqek` and verified live.

| Aegis finding | Resolution |
|---|---|
| **#1 team-wide lockout** | `team_members` writes now admin/service-role only; reads stay open. Added `protect_last_admin()` trigger (BEFORE UPDATE/DELETE, fires for all roles) blocking removal/demotion/deactivation of the last active admin. |
| **#2 secret reads bypass audit** | Dropped blanket `FOR ALL`. Table SELECT revoked; column-level SELECT granted on metadata only — `encrypted_value` is **not** selectable by `authenticated` (verified `has_column_privilege = false`). Value returns only via `get_secret()`. |
| **#3 audit log forgeable** | `activity_log` is now SELECT-only for members; INSERT/UPDATE/DELETE revoked from anon+authenticated. Writes occur via SECURITY DEFINER fns / service role only → append-only. |
| **#4 dead embedding model** | `text-embedding-004` references removed from docs; dimension stays `vector(768)` but the **model is now an open item to confirm before ingestion** (VISION §11.5). Will verify the live model independently. |
| **#5 plaintext secrets** | Documented as hard blocker: **no secret ingestion until a vault backend is chosen** (CLAUDE.md + VISION §7/§11.1). Backend decision pending Jesse. |
| **#6 doc contradiction** | `CLAUDE.md` reconciled to the full-access + integrity-gated model; `get_secret` corrected from "admin-gated" to team-gated+logged. |
| **Hardening** | All SECURITY DEFINER fns recreated with `search_path = ''`, fully-qualified objects, `PUBLIC` execute revoked (and `anon` revoked on `get_secret`). |
| **FK indexes** | Added on `memory_entries.project_id`, `documents.project_id`, `document_chunks.document_id` + 7 more (10 total). |
| **Uniqueness** | `unique (document_id, chunk_index)` added. |
| **updated_at** | Auto-touch triggers added on `projects` + `memory_entries`. |

**New capability:** `can_code` flag on `team_members` (default false). `repos` (code) is read-all,
write-gated to `can_code` (admins + named devs). Confirmed with Jesse 2026-06-14.

**Verified live:** `can_code` column present; `authed_can_read_secret = false`; policy set on the four
tables matches intent; 3 triggers; unique constraint present; 10 FK indexes; 5 fns pinned to empty
`search_path`; `get_secret` ACL = postgres/authenticated/service_role only.

**Re-review requested** on the commit that adds `0002`. Open items for Aegis/Jesse input (non-blocking
for this migration): secrets-vault encryption backend (#5/§11.1) and the embedding model (#4/§11.5).
