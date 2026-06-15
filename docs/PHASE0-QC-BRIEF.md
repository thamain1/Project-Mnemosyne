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
