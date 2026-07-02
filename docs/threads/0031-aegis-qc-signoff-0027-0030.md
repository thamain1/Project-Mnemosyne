# 0031 - Aegis QC sign-off: 0027 hosted MCP + 0030 projects backfill

- Opened: 2026-07-02
- Author: Aegis / Codex QA-QC
- Audience: Atlas, Sonnet 5, Jesse
- Status: APPROVED - Atlas may proceed

## Verdict

Aegis QC verdict: APPROVED. No blocking findings remain from the previous effort.

Atlas can proceed to the next planning/build unit.

## Scope Reviewed

This sign-off covers the immediately preceding work:

1. Thread 0027 hosted remote MCP and `brief` tool completion, including live deployment, key rotation, legacy key disablement, hosted MCP smoke, and second-machine e2e.
2. Thread 0030 projects backfill, implementing thread 0028 decision (d): seeding `projects`, linking project memory entries, linking documents, and creating/linking the missing Mnemosyne project resume through the sanctioned ingest path.

## 0027 QC Result

Verdict: APPROVED / COMPLETE.

Accepted evidence:

- Migration `0026` was applied before hosted MCP deployment.
- Service-role key was rotated.
- Legacy leaked JWT keys were disabled, not merely superseded.
- Post-rotation live smokes passed: render 19/19, telemetry 14/14, log-update 15/15, hosted MCP 60/60.
- Gate-run telemetry defects were fixed:
  - `83b859b` corrected hosted telemetry to `source='mcp'`.
  - `be0d09e` awaited `logUsage` on the hosted MCP route after `context.waitUntil` failed to land rows in this runtime path.
- Acceptance criterion 10 is complete: real `exec-pro` machine token provisioned and second-machine `claude mcp add --transport http` e2e verified from both client and server sides.
- Server-side evidence confirmed `mcp/brief` and `mcp/log_update` usage rows with `source='mcp'`, plus an `activity_log` row from `exec-pro` with linked `entity_id`.

Aegis assessment: the hosted MCP unit is live and accepted. Remaining work is future enhancement only, not a blocker.

## 0030 QC Result

Verdict: APPROVED.

Accepted evidence from the thread report and script review:

- Backfill was correctly scoped as a data unit: no schema migration.
- `scripts/backfill-projects.mjs` supports dry-run and idempotent rerun behavior.
- Projects were seeded from the canonical roster: 14 created, 0 pre-existing at first run.
- `memory_entries.project_id` backfill mapped 44 rows and intentionally left 25 NULL with reasons. Ambiguous/unmapped entries were not guessed.
- `documents.project_id` backfill mapped 13/13 documents.
- The missing Mnemosyne resume entry was created via `ingest_memory_entry`, not raw insert, then linked to the Mnemosyne project row.
- Dedicated verification passed: `scripts/verify-projects-backfill.mjs` reported 10/10.
- Full hosted MCP smoke remained green at 60/60 after adaptive fallback probe fixes.
- The slug fallback remains live for unmapped entries, as designed.
- Historical `activity_log.entity_id` backfill and CRM bridge work were correctly left out of scope.

Aegis assessment: the 0030 data backfill satisfies the data-QC gate and is approved.

## Non-Blocking Note

If `scripts/backfill-projects.mjs` remains a reusable maintenance script, tighten the actual update statements to include `project_id IS NULL` in the update predicate, not only in the initial select. Current behavior is acceptable for the completed run and idempotency proof, but the tighter predicate would protect against a rare manual-update race between select and update.

This is not a blocker and does not hold Atlas.

## Repo State Note

At the time of this sign-off, local `main` is ahead of `origin/main` by two commits:

- `d754031` - 0030 projects backfill implementation.
- `49f7bc9` - 0027 acceptance criterion 10 completion record.

Push remains under Jesse/Atlas direction. Aegis does not require further changes before Atlas proceeds.
