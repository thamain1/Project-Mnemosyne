# 0029 — Sonnet instructions: 0027 post-build QC fix round

- **Opened:** 2026-07-02 (Fable, after Aegis post-build QC `c0c94c5` = NOT APPROVED)
- **Status:** ✅ **DONE (Sonnet 5, 2026-07-02).** All 5 items fixed. `npm run build` green (incl.
  `tsconfig.functions.json`), all 239 keyless `mcp/test-*.mjs` green, `node --check` clean on every
  changed script. Item 1's representative (`smoke-render-document.mjs`) run end-to-end against prod:
  19/19, `team_members` count identical before/after (11 total / 4 inactive), zero residue. Committed
  locally with explicit paths, no push (`mcp.ts` still hard-depends on unapplied migration `0026`).
  Detail per item below. Next gate: Aegis re-QC.
  1. **FK-drop-safe cleanup** — `scripts/lib/cleanup-member.mjs` (delete actor-keyed
     activity_log/usage_events/rate_limits → try real delete → deactivate fallback → best-effort
     deleteUser). All 7 affected scripts refactored to use it (the representative run live; the other
     6 syntax-checked, not individually run, per "one representative before batch"). Also swept
     `smoke-hosted-mcp.mjs`'s own cleanup (main loop + the separate rate-limit-bucket fixture) onto the
     same helper — see item 5.
  2. **Real body-size cap** — `functions/api/mcp.ts` now stream-reads the body via
     `req.body.getReader()` with a hard 64KB byte accumulator, canceling and rejecting (413) the
     moment it's exceeded, strictly before `JSON.parse`. Content-Length check kept as a cheap
     fast-path in front. Added the required smoke case: an async-generator body (no Content-Length,
     forces chunked transfer-encoding) over the cap → 413.
  3. **`kind='machine'` enforced at both layers** — `0026_machine_accounts.sql`'s
     `verify_machine_token` WHERE clause gained `and m.kind = 'machine'`; `functions/api/mcp.ts`
     re-checks `verified.kind !== 'machine'` after the RPC call as a deliberate duplicate. Smoke: a
     token minted against a `kind='human'` row → 401, included in the byte-identical-401-shape set.
  4. **v1 = CLI/server-side only, documented** — `mcp.ts`'s header comment now states the scope
     decision explicitly (no CORS/preflight; OPTIONS → 405; browser Origins incl. `claude.ai` → 403
     pre-auth). Smoke additions: `OPTIONS` → 405 with `Allow`, and a `https://claude.ai` Origin → 403.
  5. **Hosted-smoke telemetry leak fixed** — both cleanup sites in `smoke-hosted-mcp.mjs` (the main
     fixture loop and the separate rate-limit-bucket machine) now route through `cleanupMember`, which
     unconditionally deletes `usage_events` for the actor — the previous rate-limit-bucket cleanup
     deleted `rate_limits` + `team_members` but never `usage_events`.
- **Audience:** Sonnet 5. This doc is the complete work order — no other context needed beyond the
  two referenced sections of thread 0027.
- **Ground rules:** branch `main` is 6+ commits ahead of origin and **stays unpushed**. Migration
  `0026_machine_accounts.sql` **stays unapplied** — but you may edit its file directly, precisely
  because it is unapplied (no follow-up migration for item 3).

**Read first:** `docs/threads/0027-hosted-mcp-and-brief.md` → "Aegis Post-Build QC - 2026-07-02"
section and the "Fable response to post-build QC" section directly under it. The two blockers are
Aegis's; the three decided items are Fable's rulings on Aegis's non-blocking findings. Fix all five.

## 1. Blocker — FK-drop-safe smoke/provision cleanup

Migration 0026 drops `team_members → auth.users on delete cascade`, so `deleteUser(...)`-only
cleanup will orphan active `team_members` rows post-apply. Aegis's affected list:
`scripts/smoke-contact.mjs:57`, `scripts/smoke-crm.mjs:54`, `scripts/smoke-generate-contract.mjs:94`,
`scripts/smoke-log-update.mjs:60`, `scripts/smoke-render-document.mjs:67`,
`scripts/smoke-save-document.mjs:65`, `scripts/smoke-usage-telemetry.mjs:59`.

**Fix shape:** ONE shared helper (e.g. `scripts/lib/cleanup-member.mjs`), then refactor callers:

1. Delete dependent rows for the actor (`usage_events`, `rate_limits` — check each script for others).
2. Try `delete from team_members where id = ...`.
3. On FK violation (audit rows etc.) → fall back to `update ... set active=false` (tombstone policy).
4. Then `auth.admin.deleteUser(...)`.

Requirements: idempotent; correct BOTH pre-0026 (cascade still exists) and post-0026 (it doesn't).
`scripts/smoke-save-rendered.mjs` already shows the safe pattern — match it, don't invent a new one.
**Process:** refactor ONE script first (`smoke-render-document.mjs`), run it end-to-end against prod
to prove the helper, THEN batch the remaining six (house rule: one representative before batch).

## 2. Blocker — real body-size cap on the public MCP endpoint

`functions/api/mcp.ts:171` trusts the `Content-Length` header; `:193` then calls `req.json()`
directly — a chunked/no-Content-Length request bypasses the 64 KB gate and forces a full parse.

**Fix:** stream-read the body (`req.body.getReader()` accumulation loop) with a hard 64 KB byte
limit; on exceed, cancel the reader and reject **before any `JSON.parse`**. Keep the Content-Length
check as a cheap fast-path reject in front. Then parse the accumulated text.
**Smoke addition (Aegis-required):** oversized body sent WITHOUT Content-Length (chunked;
Node `fetch` with a stream body + `duplex: 'half'`) → rejected unparsed with the cap error.

## 3. Decided — enforce `kind='machine'` at both layers

- Edit `supabase/migrations/0026_machine_accounts.sql`: `verify_machine_token` row filter gains
  `and kind = 'machine'`.
- Add a belt-and-suspenders check in `functions/api/mcp.ts` after verification.
- Smoke: a token minted against a `kind='human'` row → 401 (same shape as any bad token — no oracle).

## 4. Decided — v1 is CLI/server-side only (Origin/CORS)

- No CORS headers, no preflight support: `OPTIONS` → **405** with `Allow: POST, GET`.
- Browser `Origin` values (including `https://claude.ai`) remain **403** pre-auth.
- State the scope decision in the endpoint's header comment ("browser-hosted MCP clients = future
  unit; see 0027 Non-goals").
- Add OPTIONS→405 to the transport battery in `scripts/smoke-hosted-mcp.mjs`.

## 5. Decided — hosted-smoke telemetry leak

`scripts/smoke-hosted-mcp.mjs` cleanup (~lines 289-290) also deletes `usage_events` rows for its
fixture machine actors before deleting the member rows (service-role delete). Zero orphaned smoke
telemetry after a run. (The shared helper from item 1 may cover this — reuse it if so.)

## Verification gate (all required before re-submit)

- `npm run build` green (includes the `tsconfig.functions.json` typecheck).
- All keyless `mcp/test-*.mjs` suites green.
- `node --check` on every changed script.
- The one representative smoke (item 1) actually run against prod, clean result, no orphan rows
  (prove with a `team_members` count before/after).

## Close-out

Commit locally with **explicit paths** (never `git add -A`), log the commit to the brain
(`log_update`, `action: "work.commit"`), **NO push**. Update this doc's status line with what you
did, then stop — next gate is Aegis re-QC. After Aegis passes: Jesse apply-go for 0026 → service-role
key rotation + CF env + redeploy + existing smokes → push (clears the origin backlog) →
`smoke-hosted-mcp.mjs` vs prod → first `mnk_` token → second-machine e2e.
