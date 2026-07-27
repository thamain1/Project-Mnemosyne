# Work Order 0037 / Unit L — QC Record

**For: Aegis.** Produce the QC record for Unit L (Librarian v1, migration `0034`). Thread `0037`.

> **Read this before the build report in `docs/threads/0037-system-improvement-sprint.md`.** That
> report ends with a "QC Targets" list written *before* apply, and every gating step it names as
> outstanding has since been executed. Working from it alone will produce a QC record that re-litigates
> settled steps and misses the two defects found after it was written.

---

## 1. State at the time of this QC

Unit L is **applied, pushed, and live**. This is a QC record over shipped work, not a pre-apply gate.

| Item | State |
|---|---|
| HEAD | `76ae79e` on `main`, pushed, tree clean |
| Migration `0034` | **APPLIED** to prod (`qdugyduthemcrmtvgqek`) 2026-07-26 |
| CF Pages | deploy of `c6d9944` → `76ae79e` **Active** |
| Hosted MCP surface | **10 tools** (`revert` added) |
| Build | `npm run build` PASS (`tsc -b` + `tsconfig.functions.json` + vite) |

Relevant commits, oldest first:

- `d972e06` — Unit L work order (docs only)
- `54a83b0` — Aegis's Unit L build (migration, revert core, tools, runbook, smokes)
- `c6d9944` — `revert` added to provisioner `ALL_SCOPES`; `docs/AGENT-MCP-CONNECTION.md`
- `76ae79e` — two `smoke-librarian.mjs` defects fixed

### Pre-apply dry-run (already run — verify the method, re-run if you want independent confirmation)

Transactional dry-run against prod, Unit S method: `BEGIN` → full `0034` DDL → runtime probes →
`ROLLBACK`, with a post-rollback check that zero lifecycle columns persisted. All probes green.
Probes covered: lifecycle columns, `verified_at` backfill, recall-stat bump, **`updated_at` unchanged
before/after**, digest execution, same-day idempotency, version reader, `client_360`, ACLs,
cron registration, volatility.

### Post-apply gate (already run)

3 lifecycle columns · `verified_at` 0 nulls · `archived` 0 true (non-destructive) ·
`memory_recall_stats` exists with RLS on · **no `anon`/`authenticated` EXECUTE** on any new or
replaced function · 4 service_role grants present · cron registered exactly 1× at `10 12 * * *` ·
`recall_memory_hybrid=v`, `get_agent_client_context=v`, `get_memory_version=s`.

### Live smokes (already run)

`smoke-librarian.mjs` **12/12**, run twice consecutively · `smoke-bridge-crm-hybrid.mjs` **78/78** ·
`smoke-hosted-mcp.mjs` **98/98**.

**Do not take these numbers on faith — re-derive any you intend to sign off on.**

---

## 2. Inspection surface

### Migration
- `supabase/migrations/0034_librarian_v1.sql` (580 lines) — L1 lifecycle + curation RPCs, L2 passive
  recall counters, L3 librarian digest + cron, L5 version reader.

### Application code
- `mcp/lib/revert-core.mjs` (71) — revert core; egress secret refusal before embed, shared update
  payload construction, optimistic concurrency
- `mcp/lib/revert-core.d.mts` (16) — hand-written type decls
- `mcp/server.mjs` (194) — local stdio `revert` tool wiring
- `functions/api/mcp.ts` (531) — hosted `revert` tool, scope, rate-limit bucket
- `functions/_lib/brief.ts` (259) — archived filtering, lines ~133 and ~169
- `src/pages/Memories.tsx` (271) — archived filtering in the browse query, line ~71

### Tests
- `mcp/test-revert.mjs` (72) — local revert unit tests, reported 23/23
- `scripts/smoke-librarian.mjs` (84) — Unit L live smoke, **modified in `76ae79e`**
- `scripts/smoke-bridge-crm-hybrid.mjs` (421) — extended with recall-stat, archived-exclusion and
  unchanged-`updated_at` assertions

### Docs and tooling
- `docs/WORK-ORDER-0037-UNIT-L.md` (202) — the original work order, the spec to QC against
- `docs/threads/0037-system-improvement-sprint.md` (436) — Unit L build report at the tail
- `docs/runbooks/librarian.md` (14) — human-gated consolidation runbook
- `scripts/provision-machine.mjs` (84) — `ALL_SCOPES`, changed in `c6d9944`
- `docs/AGENT-MCP-CONNECTION.md` — agent connection guide added in `c6d9944`

---

## 3. QC targets

### 3a. Carried over from the builder's own report

1. Function ACLs, volatility, and cron registration for every new and replaced function.
2. The narrowly extended null-actor carve-out in `log_activity` for `librarian.digest`
   (`0034:350-356`). Confirm it cannot be widened by any other call path.
3. `archive_memory`'s defaulted trailing `p_reason` parameter shape (`0034:38-44`) and the
   report's flat-string JSON fields against the existing flat-detail audit contract.
4. The unchanged-`updated_at` contract, i.e. the whole reason recall stats live in a side table.

### 3b. Found after the build report was written — verify the fixes, and look for siblings

5. **`provision-machine.mjs` `ALL_SCOPES` omitted `'revert'`** while `mcp.ts` already defined the
   tool, its scope, and a 6/min rate-limit bucket. The scope could never be granted, so the tool was
   unreachable. Fixed in `c6d9944`. **Check for the same class of drift elsewhere** — any tool whose
   scope string is not grantable, or any scope in `ALL_SCOPES` with no rate-limit bucket (an unbucketed
   tool would dereference `undefined` at `mcp.ts:394-395`).
6. **`smoke-librarian.mjs` was not same-day repeatable.** `removeFixtures()` filtered digest rows on
   `detail->>source = 'smoke'`, but the digest always stamps `source='cron'` (`0034:513`), so the
   predicate matched nothing. Combined with same-day idempotency, a second run asserted against the
   *previous* run's digest, whose fixtures were already deleted. Reproduced before fixing: second run
   failed `stale fixture reported`, while `consolidation group reported` kept passing off the stale
   row because that tag is not per-run prefixed. Fixed in `76ae79e` by deleting on `digest_date`,
   matched on **UTC** since `digest_date` is Postgres `current_date`.
7. **The dead-link assertion trusted a truncated sample.** It searched `dead_links_json`, which the
   L3 trim loop caps near 950 chars (`0034:499-510`). Prod carries 30 dead links and only 9 fit, so
   the fixture was always trimmed out. Now asserts `dead_links_count` against a pre-insert baseline.
   **Audit the other three sections for the same assumption** — `stale_json`, `near_dups_json` and
   `consolidation_json` currently pass only because those lists are short on this dataset.

### 3c. Known gap — not yet covered by any smoke

8. **`revert` has never been exercised over the hosted transport.** `mcp/test-revert.mjs` is local
   only, and `smoke-hosted-mcp.mjs` predates Unit L, so its 98/98 does not touch revert. What was
   verified live is only that `revert` *appears* in `tools/list` on the deployed endpoint — presence,
   not function. **A hosted revert round-trip smoke is the main coverage hole in this unit.**

### 3d. Open design wart — report a recommendation, do not fix here

9. `*_json` truncation in the digest is **silent**. Observed on prod: `dead_links_count: 30` with a
   9-item sample; `near_dups_count: 58` with a 7-item sample. The counts are honest, but there is no
   explicit truncation flag — inconsistent with `brief`'s honest-truncation flags and `client_360`'s
   per-arm truncation counts. A flag needs a migration and **`0035` is claimed by Unit R**, so this is
   a scoping call for Atlas/Jesse, not a Unit L fix.

---

## 4. Cautions when re-running anything

- **`smoke-librarian.mjs` consumes the day's digest slot.** Its cleanup deletes the digest row for
  today's `digest_date`, and `run_memory_librarian` is same-day idempotent, so the `10 12 * * *` cron
  will not re-emit until its next run. The digest is report-only and regenerable. Deliberate trade,
  documented in the script.
- The acceptance demo — first *real* librarian digest over prod eyeballed with Jesse — has **not**
  happened. Do not mark it done.
- Live smokes create and delete fixture rows in `memory_entries` and `activity_log` in **prod**.
  Confirm cleanup ran; a failed run can leave `smoke-0034-*` rows behind.
- Do not re-run `provision-machine.mjs` to change scopes on an existing label. It mints a new token
  unconditionally (`provision-machine.mjs:69-74`) even on the idempotent update path. To change scopes
  on a live machine identity, `UPDATE team_members.scopes` — the endpoint reads it per request
  (`mcp.ts:366`), so the existing token picks it up with no re-issue.

---

## 5. Deliverable

Append a **Unit L QC Record** section to `docs/threads/0037-system-improvement-sprint.md` containing:

1. **Verdict** — PASS / PASS-with-fixes / HOLD, and what specifically it is a verdict on.
2. **Per-target findings** for every item in §3, each marked verified / defect / not-applicable, with
   the evidence (query, command, or `file:line`) that produced it. Cite what you ran; do not restate
   this document's numbers as your own findings.
3. **New defects**, each with a reproduction.
4. **Recommendation on §3d** — where the truncation flag should land.
5. **Sign-off line** with the HEAD you reviewed.

Commit the record. Do not push — Jesse pushes.
