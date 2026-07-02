# 0025 — P5-TELEMETRY: usage + token telemetry (design)

- **Opened:** 2026-07-01 (Atlas)
- **Status:** ✅ **CLOSED — LIVE for 7/7 endpoints + MCP + dashboard** (2026-07-02). The
  `generate-contract` incident is RESOLVED (root cause = missing `logUsage` import — full story in
  thread `0026`); re-instrumented in commit `7907c9b` and verified live: smoke
  (`scripts/smoke-usage-telemetry.mjs`) **14/14** against prod, generate-contract usage row shows real
  provider tokens (input 523 / output 248 on the repro payload). Migrations `0024`+`0025` applied.
- **Unit:** P5-TELEMETRY from thread `0024` Pillar 5. Sequence position: step 2 (after the hygiene
  sprint, BEFORE any optimization it is meant to judge).
- **Working model:** Atlas plans (this doc) → Aegis QC → Sonnet 5 implements → gate → smoke → live.
- **Migration number:** `0024_usage_telemetry.sql` (0023 = rate limiting); `0025_usage_events_grant_fix.sql`
  is a same-day follow-up (see Build notes).

## Incident (2026-07-02) — generate-contract 500 — RESOLVED, see thread 0026

> **Resolution (2026-07-02, Fable):** root cause was a **missing `import { logUsage } from
> '../_lib/usage'`** in `generate-contract.ts` only (the other 6 endpoints had it). esbuild (CF's
> functions bundler) ships bare identifiers as global lookups, so the deploy succeeded and threw
> `ReferenceError` at runtime — but only on the happy path that reaches the `logUsage` line, which is
> why validation 400s worked. `waitUntil` couldn't fix it: the bare identifier is evaluated
> synchronously before `waitUntil` runs. Fixed + re-instrumented in `7907c9b`, which also adds
> `tsconfig.functions.json` to `npm run build` (functions/ previously had ZERO typecheck coverage —
> the crashing version fails the new check with TS2304). The section below is the original
> investigation record, kept as-was.

Pushing the `log_usage` instrumentation broke `/api/generate-contract` in production: every call on
the happy path returned a raw Cloudflare 500 ("Worker threw exception", CF error 1101) instead of the
expected 200. The other 6 instrumented endpoints (recall, search-docs, ask-docs, render-document,
save-document, save-rendered-document) deployed and worked correctly with the identical `logUsage()`
helper and RPC.

Debugging attempted, in order:
1. **`wrangler pages deployment tail`** (with Jesse's explicit go-ahead, since it reads live prod
   traffic) — connected successfully but captured NO log line for the failing request, even across
   several retries. CF error 1101 appears to be a platform-level isolate termination that bypasses
   normal Workers Functions logging, not a catchable JS exception.
2. **Hypothesis: added latency tipped the request over Cloudflare's time budget** — generate-contract
   already runs a slow (up to 45s) Gemini `generateContent` call; awaiting one more network round-trip
   (the `log_usage` RPC) after it seemed like a plausible way to cross a per-request limit. Fix: switched
   all 7 endpoints from `await logUsage(...)` to `context.waitUntil(logUsage(...))` (fire-and-forget,
   never adds response latency — this is the more correct pattern regardless, kept for the other 6).
   **Did NOT fix it** — identical 500 after redeploy. Hypothesis rejected.
3. **Reverted `generate-contract.ts` to the exact pre-instrumentation content** (from commit `788200b`)
   to restore service. Confirmed restored: 200 with the exact payload that was crashing moments earlier.

**Static code review found no logical bug** in the diff (a `generate()` return-type change to also
capture `usageMetadata.promptTokenCount`/`candidatesTokenCount`, plus one `logUsage()` call at the end)
— it mirrors the working pattern in `ask-docs.ts` (which also parses `usageMetadata` and also calls
Gemini `generateContent`, and works fine live). What's specific to `generate-contract.ts` and not
`ask-docs.ts`: the grounding/exemplar embed step, the larger prompt (up to 4 draft sections plus
governance preamble), and a bigger assembled output (`md`, a full contract with boilerplate). None of
these were conclusively implicated — this needs either working `wrangler tail` output for this specific
error class, or a bisection redeploy test outside of live prod hours.

**Current state:** `generate-contract` has NO usage telemetry. The other 6 endpoints + MCP + dashboard
are live and confirmed working. This is an open item, not closed — see thread `0024`'s open-items list.

## Build notes (Sonnet 5, 2026-07-01/02)

- **Schema/RPC:** `supabase/migrations/0024_usage_telemetry.sql` — `usage_events` table + `log_usage()`
  RPC, matching 0023's posture exactly (RLS on, explicit revoke from anon/authenticated, member
  SELECT-only via `is_team_member()`, `log_usage` granted to `service_role` only). **Bug found on
  apply:** `0024` copied `0023`'s `revoke all` verbatim, which also revoked the base SELECT grant that
  the member-select RLS policy needs underneath it (unlike `rate_limits`, `usage_events` IS meant to be
  member-readable) — authenticated got "permission denied for table" before RLS even evaluated. Fixed
  by `0025_usage_events_grant_fix.sql` (grants SELECT to `authenticated`, matching `activity_log`'s
  pattern). Both migrations applied to prod and verified via direct grant queries.
- **Shared helpers:** `functions/_lib/usage.ts` (`logUsage`, CF endpoints) and `mcp/lib/usage-core.mjs`
  (`logMcpUsage` + `TELEMETRY_ON` env gate, MCP server). Both wrap the RPC call in try/catch with no
  rethrow — a telemetry failure can never fail the parent request (this is the structural proof for
  gate criterion 4, verified by code inspection + `mcp/test-usage.mjs`, not live fault injection). All
  callers use `context.waitUntil(logUsage(...))`, not `await`, so telemetry never adds response latency.
- **Instrumented (6 of 7 CF endpoints — see Incident):** `recall`, `search-docs`, `ask-docs`,
  `render-document`, `save-document`, `save-rendered-document`. Each fires one best-effort `log_usage`
  after its work completes. `generate-contract` is NOT instrumented (reverted after a P0 incident).
- **Instrumented (MCP):** all 6 tool handlers wrapped at the `CallToolRequestSchema` dispatch level in
  `mcp/server.mjs` (not inside each core, to keep cores pure/testable) — records `bytes_in`/`bytes_out`
  (args/result JSON length) and success/failure. Env-gated `MNEMOSYNE_TELEMETRY` (default on).
- **Dashboard:** small "Usage — last 7 days" card added to `src/pages/Activity.tsx` (not a new tab) —
  per-tool totals table (calls, tokens, bytes) + top-5 actors table. Client-side aggregation of one
  capped SELECT (limit 5000) against `usage_events`, readable under the member SELECT policy. No charts.
- **Spec deviation (flagged, not silently resolved):** the design doc's acceptance criterion 2 says a
  `/api/recall` call should produce "provider token counts populated" — but `recall`/`search-docs` only
  call Gemini's `embedContent`, which does not expose `usageMetadata` (unlike `generateContent`). Token
  counts for embed-only calls are honestly `null`; bytes are the proxy metric, per the design's own
  "Honest scope" section. `ask-docs` (which DOES call `generateContent`) confirms real tokens populate
  correctly; `generate-contract` was meant to be the other such proof point but is currently reverted.
- **MCP live-stdio smoke (gate criterion 5) NOT built:** no existing MCP test in this repo spawns the
  real stdio server (`mcp/test-*.mjs` are all keyless, mocked-rpc unit tests) — there's no established
  pattern to extend. Built the keyless equivalent instead (`mcp/test-usage.mjs`, 5/5 passing) covering
  `logMcpUsage`'s RPC shape, actor-null coercion, and best-effort swallow-on-error. The live DB write
  path itself (`log_usage` grants) IS exercised live by `smoke-usage-telemetry.mjs` criterion 1c.
- ~~**Open item:** find the real root cause of the `generate-contract` crash and re-instrument it.~~
  **DONE 2026-07-02** (`7907c9b`, thread `0026`): missing import, re-instrumented, smoke 14/14 —
  generate-contract is now the second `generateContent` proof point with real token counts (523/248).

## Why (one paragraph)

TOKEN-GOVERNANCE §3.1 admits its own central claims are unmeasured ("unproven, pending He1/He3") and
nothing anywhere records what agents/endpoints actually spend. Every later Pillar-5 optimization
(fetch-scope, brief caps, agent diet, model tiering) needs a baseline and a before/after. This unit is
deliberately small: one table, one RPC, instrumentation at the spend points we control, one dashboard
rollup.

## Honest scope (what we can and cannot measure)

- **CAN measure server-side:** Gemini embed/generation token counts (returned in API responses),
  Browser Rendering call counts, request/response payload byte sizes per MCP tool call and per CF
  endpoint call, call counts per actor/bucket (rate_limits already tracks takes).
- **CANNOT measure server-side:** the Claude-side context-window tokens of a teammate's session. Proxy
  metric: `bytes_in`/`bytes_out` per MCP tool call (chars ≈ tokens/4). Good enough for before/after
  comparisons; do NOT present it as exact tokens in the UI — label it "payload bytes".

## Schema (migration 0024 — additive only)

```sql
create table public.usage_events (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid references public.team_members (id) on delete set null,
  source       text not null,        -- 'mcp' | 'endpoint' | 'script'
  tool         text not null,        -- e.g. 'recall', 'fetch', 'api/generate-contract'
  model        text,                 -- 'gemini-embedding-001', 'gemini-2.5-flash', null for render
  input_tokens  int,                 -- provider-reported, null when unknown
  output_tokens int,
  bytes_in     int,                  -- request payload size (proxy metric)
  bytes_out    int,                  -- response payload size
  ok           boolean not null default true,
  created_at   timestamptz not null default now()
);
```

Constraints + posture (follow 0023's pattern exactly):
- RLS on; explicit `revoke all ... from anon, authenticated` (this project AUTO-GRANTS on new public
  tables); members get SELECT-only via a policy (`is_team_member()`) so the dashboard can read rollups.
- Writes ONLY via `log_usage(...)` RPC: `security definer set search_path=''`, service_role execute
  only, validates source/tool against length + charset caps, clamps ints to >= 0, NO free-text fields
  beyond tool/model (nothing to secret-scan — never log query text, titles, or bodies; this is the
  standing rule from recall.ts's audit note).
- Index: `(created_at desc)` and `(actor_id, tool, created_at desc)`. No vector, no FKs beyond actor.
- Retention: none in v1 (volume is low). Revisit if > ~100k rows.

## Instrumentation points (build order)

1. **CF endpoints** (the money spenders): `recall`, `ask-docs`, `search-docs`, `generate-contract`,
   `render-document`, `save-document`, `save-rendered-document`. After the work completes, fire ONE
   best-effort `log_usage` (never block or fail the request on telemetry failure — catch and drop;
   same "best-effort" convention as SendGrid sends in Perks). Gemini responses expose
   `usageMetadata.promptTokenCount` / `candidatesTokenCount` — record them; for embeds record the
   model + bytes; for renders record model=null, bytes_out = PDF size.
2. **MCP server** (`mcp/server.mjs`): wrap the 6 tool handlers; record bytes_in (args JSON length),
   bytes_out (result JSON length), plus Gemini usage where the tool embeds (recall/remember/update).
   Env gate `MNEMOSYNE_TELEMETRY=1` (default on) so it can be killed without redeploy.
3. **Dashboard rollup** (small): a "Usage" card on the Activity tab (not a new tab): last-7-days
   per-tool totals (calls, provider tokens, bytes) + per-actor top-5. One SELECT with group-by;
   member-readable per the RLS above. No charts in v1 — a table is fine.

## Acceptance criteria (the gate)

1. Migration applies clean; direct INSERT into `usage_events` as anon/authenticated fails `42501`;
   member SELECT succeeds; `log_usage` executes only as service_role (prove all four, per the
   write-gates-are-policy-not-convention standard).
2. A live `/api/recall` call produces exactly one usage row with provider token counts populated.
3. A `render-document` call produces a row with bytes_out ≈ PDF size.
4. Telemetry failure (e.g. RPC dropped) does NOT fail the parent request — prove by reverting grant in
   a branch test or mocking the RPC error in a unit test.
5. MCP smoke: one recall via stdio server writes one row (or zero with MNEMOSYNE_TELEMETRY=0).
6. `npm run build` green; endpoint smokes (existing scripts) still pass.

## Non-goals (v1)

- No cost-in-dollars column (rates change; compute in the dashboard query if wanted later).
- No Claude-session token capture (not observable server-side; the bytes proxy is the honest v1).
- No alerting/quotas — that's what rate limiting (0023) is for.
- No logging of query text, titles, bodies, or any free-form user content. Ever.

## Rollback

Additive table + RPC; rollback = revoke/drop in a follow-up migration. Instrumentation is best-effort
try/catch — removing the RPC degrades to no-op, does not break endpoints (unlike 0023's wiring; see QC
finding in thread 0024 about deploy-before-apply ordering — Sonnet: the try/catch requirement above is
what prevents a repeat here).
