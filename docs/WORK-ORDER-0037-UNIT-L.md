# WORK ORDER — 0037 Unit L: Librarian v1, the memory lifecycle (migration `0034`)

- **Design:** `docs/threads/0037-system-improvement-sprint.md` § Unit L — READ IT FIRST, plus the
  Unit S QC record (the role-swap discipline carries over).
- **Roles:** **Aegis BUILDS. Atlas/Fable QCs.** Same standing instruction as Unit S: if a spec line
  below contradicts the live code/schema, STOP and record the discrepancy in the thread doc — the
  Unit S round proved this catches design errors (fts-only fixture).
- **Discipline:** migration `0034` written but **HELD UNAPPLIED** until QC + Jesse apply-go. Code
  that references new columns/RPCs (brief filter, UI filter, revert tool) pushes only AFTER apply.
  Commit, don't push, until the apply-go step. Log commits via the operator MCP path — do NOT mint
  a machine token in-session (Unit S QC note).
- **Verified ground truth (2026-07-10, HEAD `33386e0`):**
  - ⚠️ **`trg_memory_entries_updated_at` (0002:155) fires BEFORE UPDATE on `memory_entries`** — any
    plain UPDATE touches `updated_at`. A recall-stat bump on the entries table would therefore
    (a) create a recency-boost feedback loop (recalled → looks fresher → boosted → recalled more)
    and (b) break `update_memory`'s mandatory `expected_updated_at` for concurrent operators.
    **This is why recall stats live in a SIDE-TABLE (L1/L2), not on `memory_entries`. Do not
    "simplify" them back onto the entries table.**
  - `memory_versions` (0021:62-77): full prior state incl. `body`; service-role-only by design; **one
    intentionally-retained secret-contaminated v1 snapshot exists** (2026-06-26 incident record) —
    the revert path MUST egress secret-scan before the body reaches an embed call or any output.
  - `recall_memory_hybrid` is the 0033 8-column version, `stable`. `get_agent_client_context` is
    live (0033), `stable`. Both must become `volatile` to carry the L2 bump (data-modifying CTE is
    illegal in a stable function).
  - Agent-outcome memories carry provenance `source_path` under an `agent/<slug>/…` prefix —
    **verify the exact prefix in `0031` before writing the consolidation-queue query.**
  - Cron precedent: `run_stale_deals_digest` + schedule block (`0027:596-648`), 12:00 UTC daily,
    same-day idempotent via its own activity check.

---

## L1 — Curation columns + recall-stats side-table (migration `0034` part 1)

```sql
alter table public.memory_entries
  add column if not exists verified_at   timestamptz,
  add column if not exists archived      boolean not null default false,
  add column if not exists superseded_by uuid references public.memory_entries(id);

update public.memory_entries set verified_at = updated_at where verified_at is null;
```
(Yes, the backfill UPDATE fires the trigger and touches `updated_at` once — acceptable one-shot;
note it in the migration comment so the post-apply gate isn't surprised by fresh timestamps.
Actually better: **disable the trigger around the backfill** (`alter table … disable trigger
trg_memory_entries_updated_at; update …; alter table … enable trigger …`) so history stays honest —
do it this way.)

```sql
create table if not exists public.memory_recall_stats (
  entry_id         uuid primary key references public.memory_entries(id) on delete cascade,
  recall_count     int not null default 0,
  last_recalled_at timestamptz
);
alter table public.memory_recall_stats enable row level security;
revoke all on public.memory_recall_stats from anon, authenticated;
grant select on public.memory_recall_stats to authenticated;  -- dashboard reads (member RLS via policy)
```
Add a `team_all`-style SELECT policy matching the house pattern (see `usage_events` 0025's member-
SELECT fix — copy that shape, not `0023`'s revoke-everything, which was the 0025 bug). No client
INSERT/UPDATE grants — the only writers are the two volatile RPCs (definer).

**Archived filter lands in every RECALL path, this migration + this unit's code:**
- `recall_memory_hybrid` — `scoped` CTE gains `and not e.archived` (chunks join through `scoped`,
  so covered).
- `get_agent_client_context` — same predicate.
- `client_360` — the memories array subquery gains the filter (`create or replace` is fine here:
  return type unchanged).
- `functions/_lib/brief.ts` — resume/entry reads add `.eq('archived', false)` (CODE, post-apply).
- `src/pages/Memories.tsx` — browse query filters `archived = false` (CODE, post-apply; no toggle
  in v1).
- NOT filtered, by design: `get_memory_entry`/fetch (operators may read archived entries by name),
  `memory_versions`, old `recall_memory` (dashboard endpoint — being retired in Unit R; leave it).

**Curation RPCs (both: security definer, empty search_path, service-role-only execute, audited via
`public.log_activity`):**
- `archive_memory(p_actor uuid, p_name text, p_archived boolean, p_superseded_by uuid default null,
  p_reason text)` — validates actor (active team_members row) + entry exists; if `p_superseded_by`
  given, target must exist and not be the entry itself; sets the three fields; logs
  `memory.archive` / `memory.unarchive` with name + reason. No `memory_versions` snapshot (curation
  state, not content).
- `confirm_memory_verified(p_actor uuid, p_name text)` — sets `verified_at = now()`, logs
  `memory.verify`. NOTE: the updated_at trigger WILL fire on both RPCs — for `confirm` that is
  deliberate (a human confirmation IS freshness, the recency boost should see it); say so in a
  comment. For `archive` it's harmless (archived rows are out of recall entirely).

## L2 — Recall bump inside the two read RPCs (migration `0034` part 2)

Re-create `recall_memory_hybrid` (return type UNCHANGED — plain `create or replace`, no drop) and
`get_agent_client_context` as **`volatile`**, with the existing query wrapped so a data-modifying
CTE upserts stats for exactly the returned rows:

```sql
-- shape sketch for the hybrid (same idea in get_agent_client_context):
with final_results as (
  <the entire existing 0033 query, unchanged, but carry s.id through to the final select>
),
bump as (
  insert into public.memory_recall_stats (entry_id, recall_count, last_recalled_at)
  select fr.id, 1, now() from final_results fr
  on conflict (entry_id) do update
    set recall_count = public.memory_recall_stats.recall_count + 1,
        last_recalled_at = now()
)
select <the 8 declared columns> from final_results;
```
Binding details: the outer SELECT must NOT expose the carried `id` (return shape stays 8-col);
ranking/limit semantics stay byte-identical to 0033; `#variable_conflict use_column` stays; ACL
revoke/grant blocks re-issued if you end up dropping (you shouldn't need to — volatility and body
are `create or replace`-safe when the signature is unchanged). **Zero caller changes** — that is
the point of doing the bump in-function. Old `recall_memory` gets NO bump (retiring, Unit R).

## L3 — Librarian cron (migration `0034` part 3)

`run_memory_librarian()` — clone the `run_stale_deals_digest` shape (definer, same-day idempotent
via a `librarian.digest` activity check, one activity row, revoke from client roles, grant
service_role for direct smoke calls). Schedule `mnemosyne_memory_librarian_daily` at `10 12 * * *`
(12:10 UTC — offset from the stale-deals job) with the unschedule-if-exists guard.

Digest detail (flat JSON, cap each list; the cron REPORTS, never mutates):
- `stale` (≤15, oldest first): `not archived` and `verified_at < now() - interval '6 months'`, OR
  `< now() - interval '2 months'` when `client_id is not null or deal_id is not null` (CRM-linked =
  lead intel; thresholds as named constants with a tuning comment — Jesse's open question #2
  defaulted, not decided).
- `near_dups` (≤10 pairs): entry-level embeddings only, `not archived`, `a.name < b.name`,
  cosine distance below a named-constant threshold (start `0.10`); return names + similarity.
  O(N²) at ~200 rows is trivial; add a row-count guard comment for the future.
- `dead_links` (≤15): `unnest(links)` targets with no matching `memory_entries.name`. A link to an
  ARCHIVED entry is NOT dead.
- `consolidation_queue`: `client:%` tag groups over agent-provenance rows (`source_path like` the
  0031 prefix — verify it) with ≥3 un-archived entries; return tag + count.

## L4 — Librarian runbook (`docs/runbooks/librarian.md`) — the LLM half (docs only)

Committed procedure, `prospect-research.md` discipline: operator (or dispatched agent with Jesse's
go) reads the latest `librarian.digest` → per consolidation-queue group: merge into ONE distilled
pattern memory via `update_memory` (**consolidation-over-creation: patch an existing entry first;
new entry = last resort**), then `archive_memory` the originals with `superseded_by` → per stale
item: `confirm_memory_verified` if still true, `update_memory` if drifted, `archive_memory` if
dead → fix dead links via `update_memory` → close with a `log_update` `librarian.run` summary
(counts only). Human-gated in v1: the runbook explicitly forbids unattended bulk archiving —
curation is reviewed work, that's the anti-self-poisoning layer. L6 (activity→memory synthesis)
is a SECTION of this runbook (weekly per-project rollup into the project's resume memory), not a
separate pipeline.

## L5 — Revert (migration `0034` part 4 + app-layer core + tools)

- **Migration:** `get_memory_version(p_name text, p_version_no int)` — service-role-only definer
  reader returning the full version row (all 0021 columns). Validates entry exists; raises on
  missing version. Read 0021 for the exact column list — do not guess.
- **`mcp/lib/revert-core.mjs`** (+ hand-written `.d.mts`, house pattern): validate args →
  `get_memory_entry` (current `updated_at` for the concurrency token + confirm entry exists) →
  `get_memory_version` → **egress secret-scan the version body BEFORE anything else touches it**
  (shared patterns from `remember-core`; on hit: REFUSE with a clear error naming the version —
  the contaminated v1 snapshot in prod is exactly this case; never scrub-and-proceed) → rebuild
  embedding + chunks by REUSING `update-core`'s payload builder (do not duplicate the embed/chunk
  logic) → `update_memory` with `expected_updated_at` and
  `change_reason = 'revert to v<N>' + optional operator reason`. Reverting creates a NEW version —
  history stays append-only. Only fields `update_memory` accepts get reverted (read its allowlist
  in 0021; if `kind` isn't updatable, a kind-divergent revert refuses with a clear error).
- **Tools:** local `mcp/server.mjs` + hosted `mcp.ts` gain `revert` (scope token `revert`), wired
  exactly like `update`. Grant the scope sparingly (provisioning docs note). Keyless test suite
  `mcp/test-revert.mjs` (validation, secret-scan refusal, concurrency-token pass-through, RPC
  error propagation, payload-builder reuse).

## L7 — Carried chore: flip the stale `mcp.ts:14-16` rotation comment to past-tense (S1 close-out
record, 2026-07-10) — one comment edit, riding this unit's code push.

---

## Order of execution

1. Build everything: `supabase/migrations/0034_librarian_v1.sql` (parts 1–4, one file), RPC caller
   code (brief/Memories filters, revert core + tools, L7 comment), runbook doc, keyless tests, new
   `scripts/smoke-librarian.mjs` (fixtures → direct `run_memory_librarian()` → assert all four
   digest sections + same-day idempotency → cleanup) and revert round-trip smoke (create → update →
   revert → assert body restored + new version row + audit), plus hybrid-smoke extensions (archived
   entry excluded from recall; bump row lands in `memory_recall_stats` with correct count; **and a
   regression check that recalling does NOT change the entry's `updated_at`** — the trigger trap
   made explicit). Commit, no push. `npm run build` + all keyless suites green.
2. **STOP → Atlas/Fable QC** (will include a transactional dry-run of `0034` against prod with
   runtime probes + rollback — the Unit S method; write the migration knowing it will be exercised
   that way).
3. Jesse apply-go → apply via Management API → post-apply gate (`pg_proc.proacl` on all new/replaced
   functions; volatile-flag check via `pg_proc.provolatile`; cron job registered; backfill sane —
   `verified_at` populated, `updated_at` histogram unchanged).
4. Push → CF deploy → full live smoke set (librarian, revert, agent-api, bridge-crm-hybrid,
   hosted-mcp, log-update) → run one real librarian digest against prod data and eyeball it with
   Jesse (the first digest over 201 real entries IS the acceptance demo).
5. Atlas/Fable final QC record in the thread doc → MEMORY.md state bump.

## Acceptance

- Recalling an entry N times shows `recall_count = N`, `last_recalled_at` fresh, and the entry's
  `updated_at` UNCHANGED (the trigger trap, proven by smoke).
- An archived entry stops appearing in hybrid recall, agent-context, client_360, brief, and the
  Memories UI — but is still fetchable by name; unarchive restores it.
- `run_memory_librarian()` produces one same-day-idempotent digest row with all four sections
  correct against seeded fixtures, and a plausible digest against real prod data.
- Revert round-trip restores a prior body verbatim (re-embedded, new version row, audited);
  reverting to the known-contaminated version class REFUSES on the secret scan.
- Keyless suites + `npm run build` green; live smokes green; no ranking change in recall (0033
  ordering preserved — L2 only wraps it).
