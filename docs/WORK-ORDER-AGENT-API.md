# WORK ORDER — Agent Context & Outcome API (IntelliService wiring, Mnemosyne side)

**Created:** 2026-07-06 (Atlas) · **Repo:** `C:\Dev\Project-Mnemosyne`, branch `main`
**Status:** 📋 READY FOR PICKUP
**Context:** IntelliService-ISB's dispatch + contract agents have an env-gated Mnemosyne interface shipped since their WO 0003/0004 (`MNEMOSYNE_RECALL_URL`/`MNEMOSYNE_TOKEN`, unset). Jesse greenlit the wiring (2026-07-06): Mnemosyne = the central qualitative brain for IntelliService agents — recall in, outcomes out. **Per-client namespaces on THIS instance** (his approved architecture); **Demo wiring only for now — the production client token is NOT minted until contract data-use language exists** (hard gate, Jesse's). The existing `/api/recall` does NOT fit: it auths human team members via Supabase JWT and takes a free-text query; agents need a service-token endpoint with a structured request. Companion WO on the ISB side: `C:\dev\IntelliServiceBeta\project\docs\0023-wo-mnemosyne-wiring-isb.md` (consumes what this builds).

## Ground rules (this repo's standards)

Read `CLAUDE.md`, `docs/MCP-DESIGN.md`, and the `functions/api/recall.ts` + `functions/api/log-update.ts` sources FIRST — new endpoints must match the house patterns exactly: fail-closed auth, `additionalProperties:false` request validation, per-actor rate limiting via `rate_take`, `logUsage`, secrets from `context.env` never VITE_-prefixed, no query text in any audit. Migrations follow the `00NN_name.sql` convention, additive. Commit style + thread-doc conventions per the repo. **Do NOT touch the Berkeley/lead-gen work or threads 0035/0036 — this WO is orthogonal to the paused pipeline.**

## What ISB sends / expects (fixed contract — the ISB stub already ships)

- **Recall**: `POST` w/ `Authorization: Bearer <client token>`, body `{ customer_id: string, tech_ids: string[] }` (ISB's own UUIDs) → `200 { context: string | null }`. ISB truncates at 2000 chars and times out at 5s — the endpoint should respond well inside that and cap its own output ≤2000 chars.
- **Outcome** (new, shape negotiated with the ISB WO): `POST` Bearer, body `{ event_type: string, summary: string, customer_id?: string, customer_name?: string, tech_id?: string, tech_name?: string, ref?: string }` → `200 { ok: true }`. `event_type` from a small allowlist: `dispatch_rejected`, `dispatch_override`, `contract_won`, `contract_lost`, `contract_dismissed`, `note`.

## The work

### 1. Client registry + tokens (migration)

- `agent_clients` table: `client_slug` (PK-ish unique, e.g. `dunaway-isb-demo`), `display_name`, `token_hash` (sha256 of a long random token — never store plaintext), `is_active`, `created_at`, `notes`. Service-role only (no RLS exposure to the dashboard yet).
- Verification helper (SECURITY DEFINER or in-function): constant-time-ish hash compare → returns the client row or null. Fail closed on inactive.
- **Mint exactly ONE client this WO: `dunaway-isb-demo`.** Generate the token, output it ONCE in the Receiver log for Atlas to move into ISB's Demo secrets (it's a cross-system credential — do not commit it anywhere; the log line should say "token delivered out-of-band" and the actual value goes in the out-of-band handoff per the Sealed Credential standard). NO production client — that's gated on contract language (Jesse).

### 2. Namespace convention

- All agent-sourced memories carry tags: `client:<client_slug>` + entity tags `isb-customer:<uuid>` / `isb-tech:<uuid>` (ISB's UUIDs are the join keys — Mnemosyne doesn't need its own entity rows for v1).
- Recall for a client filters `tags @> '{client:<slug>}'` ALWAYS — cross-client leakage is the one unforgivable bug here. Prove it in verification (client A's token must never surface client B's memories; seed a second dummy client's memory to prove the negative).

### 3. `/api/agent-context` (the recall side)

- Auth: Bearer client token → registry check (fail closed, 401).
- Rate limit per client_slug (reuse `rate_take`; suggest 60/min — dispatch batches hit this once per ticket).
- Lookup: memories tagged `client:<slug>` AND (`isb-customer:<customer_id>` OR any `isb-tech:<id>` in `tech_ids`). Tag-filtered, ordered by recency/importance — **NO Gemini embed call in v1** (the structured tags make semantic search unnecessary and keep this endpoint fast + free; note this as the deliberate design divergence from `/api/recall`).
- Compose `context`: a compact plain-text digest — customer-scoped facts first, then per-tech facts, newest first, hard cap 2000 chars, `null` when nothing found. No IDs in the prose (the agent prompt doesn't need them — names/facts only).
- Audit: safe metadata only (client_slug, counts, timing) — never memory content.

### 4. `/api/agent-outcome` (the write side — DISTILL, DON'T ACCUMULATE)

This is the payload rule Jesse and Atlas settled (2026-07-04): Mnemosyne receives **only qualitative signal**, never raw session/operational data (that stays in ISB's `agent_session_logs`).

- Auth + rate limit as above (suggest 120/min).
- Validation: allowlisted `event_type`; `summary` required, bounded (≤500 chars), secret-scanned (reuse `log_update`'s scan).
- Write path: one `activity_log` append (action `agent.<event_type>`, detail = the bounded payload) — the audit trail. PLUS a `memory_entries` row ONLY when the event carries reusable qualitative content (`dispatch_rejected` w/ reason, `contract_lost` w/ reason, `dispatch_override`, `note`) — tagged per §2. Plain `contract_won` w/o notable content = activity log only. Embedding: reuse the existing ingest path if cheap; if the ingest RPC requires an embedding, use the house embed helper (RETRIEVAL_DOCUMENT) — this endpoint may spend an embed call; rate limit accordingly.
- **No consolidation job this WO** — flag in the Receiver log that a periodic rollup (per customer-tech pair, event rows → one living summary) is the designed v2; volume math says this is years away from mattering at one client.

### 5. Docs + provisioning note

- Short section in `docs/MCP-DESIGN.md` or a new `docs/AGENT-API.md`: the two endpoints, auth model, namespace convention, the demo-vs-prod token gate, and the distill rule. Future clients = one registry row + one token.

## Verify + close out (live, both directions)

1. Seed 3 real-shaped memories for `dunaway-isb-demo` (a customer preference, a tech-site note, a rejection lesson — tagged per §2) + 1 memory for a dummy `other-client` slug.
2. `agent-context` with the real token + matching IDs → composed digest ≤2000 chars containing the 3 facts; with a random/inactive token → 401; **with the real token but the dummy client's entity tags → the other client's memory NEVER appears** (the leakage negative, prove it).
3. `agent-outcome`: allowlisted event w/ reason → activity row + tagged memory row; `contract_won` w/o content → activity row only; oversized summary → rejected; secret-looking string in summary → scrubbed/rejected per house scan; bad event_type → 400.
4. Round-trip: the outcome memory from #3 shows up in the next `agent-context` call for that customer — the learning loop, closed, live.
5. Rate limit trips at the configured threshold (prove once).
6. Build/deploy per this repo's flow (CF Pages — remember functions deploy with the site; `npm run build` + the repo's deploy convention), commit, push per repo rules, thread-doc or Receiver-log the work, Mnemosyne `log_update` the milestone (yes, dogfooding).
7. Cleanup: dummy-client memory + test outcome rows removed or clearly test-tagged; the 3 seed memories for `dunaway-isb-demo` MAY stay (they're plausible starter content) — note the choice.

## OUT of scope

Production client token (contract-language gate — Jesse). ISB-side code (companion WO). Consolidation/rollup job (v2, flagged). Dashboard surfaces for agent memories. Telemetry aggregates (derivable later from tagged activity). Berkeley/lead-gen anything.

---

## Receiver log

*(Executor: append findings, deviations, and verification evidence here. The demo client token goes to Atlas out-of-band — NOT in this file.)*

**2026-07-06 (Sonnet) — BUILD + LIVE VERIFICATION COMPLETE. Commits `f71fe1a` (build) + `fbd9f36` (Atlas's fix), pushed, CF Pages deployed (`b74d4105`).**

- **Design decisions beyond the WO's explicit text**, so they're recorded, not just implicit in the diff:
  - `record_agent_outcome(p_actor, p_client_slug, p_action, p_detail, p_memory)` — one new atomic RPC rather than reusing/extending `remember_memory`. Reasoning: `remember_memory`'s provenance regex hardcodes `mcp/<slug>` (operator-authored via the MCP `remember` tool); agent-outcome writes come from an unrelated system-actor identity and deserve their own provenance lane (`agent/<client_slug>/<name>`) for future audit clarity, matching the existing dual-guard pattern between `ingest_memory_entry` (file-backed) and `remember_memory` (operator) in 0007/0009. Also let the activity_log action be exactly `agent.<event_type>` (per WO §4) rather than `remember_memory`'s hardcoded `memory.remember` — the two write paths' audit semantics genuinely differ.
  - One fixed **system team_member row** (`Agent API (system)`, id `1788c353-8921-418b-9db4-fa8ca388c1b0`, kind=`machine`) is the actor for ALL agent_clients calls (audit + `rate_take`), rather than giving each client its own team_members row. Per-client isolation comes from the `rate_limits` bucket string (`agent_context:<slug>` / `agent_outcome:<slug>`) and from `activity_log.detail.client_slug` / `memory_entries.tags` — never from actor identity. Mirrors the pre-existing "operator member" pattern (one configured actor serving many logical callers) rather than inventing a new identity type needing its own FKs through activity_log/rate_limits/memory_entries.
  - DB-level invariant added beyond the WO text: `record_agent_outcome` REQUIRES a memory payload's tags to literally include `client:<p_client_slug>` (the authenticated caller's own resolved slug) — rejects otherwise. This is the belt-and-suspenders backstop for the "cross-client leakage is unforgivable" requirement, independent of whatever the app layer computed.
  - `contract_dismissed` was NOT added to `MEMORY_EVENT_TYPES` — the WO's verify checklist only names `dispatch_rejected`/`dispatch_override`/`contract_lost`/`note` as memory-worthy; `contract_dismissed` behaves like `contract_won` (activity-log-only) in v1. Flagging in case that's wrong — trivial one-line change if Jesse wants it to carry a reason too.
  - `agent-context`'s digest partitions returned rows into customer-scoped-first / tech-scoped-after by checking which tag matched, both arms already newest-first from the query's `order by updated_at desc` — matches WO §3 exactly ("customer-scoped facts first, then per-tech facts, newest first").

- **Bug caught before this ever ran live**: Atlas's pre-apply review found `record_agent_outcome`'s memory-key allowlist omitted `'embedding'` while the validation immediately below unconditionally required it as a non-null string — every memory write would have failed either the allowlist check or the embedding-presence check. Fixed in the applied migration (commit `fbd9f36`); confirmed live via the verification suite below (`3 memory-worthy events -> 3 new tagged memory rows` passed against the deployed function calling the corrected RPC).

- **Live verification**: `scripts/smoke-agent-api.mjs` against `https://project-mnemosyne.pages.dev`, **30/30 PASS**, using disposable `smoke-agent-{a,b,c,d}-<stamp>` clients (never `dunaway-isb-demo` — not minted this session, per instruction). Covered the full WO checklist:
  1. Seeded 3 real-shaped memories for client A (customer preference, tech-site note, rejection lesson) via real `agent-outcome` calls (not direct DB inserts) — exercises the actual write path end-to-end, including Atlas's fix.
  2. `agent-context` with the real token + matching ids → digest contains all 3 facts, ≤2000 chars, no raw uuids in the prose; wrong/deactivated token → 401 (both endpoints, identical shape); a client with zero memories → `context: null`.
  3. **Cross-client leakage negative, both directions**: seeded client B's own memory tagged to the SAME `customer_id` as client A (maximally strict case) — client A's context NEVER contains client B's marker string, and client B's context NEVER contains client A's content. This is the invariant the WO calls unforgivable to get wrong; it held.
  4. `agent-outcome`: allowlisted event w/ reason → activity + tagged memory (3/3); `contract_won` w/o distinguishing content → activity row only, memory count unchanged; oversized summary (>500) → 400; secret-looking summary (`AKIA...`) → 400 rejected by the reused `scanSecret`; bad `event_type` → 400; missing `summary` → 400.
  5. Round-trip: the 3 outcome-written memories all surfaced in the very next `agent-context` call for that customer/tech — the learning loop, closed, live.
  6. Rate limit: proved once per endpoint by presetting the `rate_limits` bucket deeply negative (avoids firing 60-120 real requests; also avoids a flaky near-zero preset racing the token-bucket's continuous refill under real network latency — first attempt at `tokens=0` intermittently refilled past 1 before the request landed).
  7. Cleanup verified empty post-run: zero leftover `agent_clients`/`memory_entries`/`rate_limits` rows matching the test stamp, and `agent_clients` table confirmed EMPTY overall (no real client minted).

- **Not done in this unit** (by instruction, not oversight): the real `dunaway-isb-demo` agent_clients row / token. Atlas mints it separately with output redirected straight to a sealed local file, moved into ISB's Demo secrets from there — never entering a chat transcript. `scripts/provision-agent-client.mjs dunaway-isb-demo "Dunaway ISB Demo"` is ready for that run.

- **Build/deploy record**: `npm run build` (tsc -b + tsconfig.functions.json + vite build) clean before every commit. Commits: `f71fe1a` (migration 0031 first pass + both endpoints + docs + provisioning script), `fbd9f36` (Atlas's allowlist fix, applied-version parity), plus this doc's own commit. Pushed to `main`; CF Pages auto-deployed `b74d4105`.

- **Follow-ups for whoever picks up next**: (a) mint `dunaway-isb-demo` (Atlas, out-of-band) and hand off to ISB per the companion WO; (b) ISB-side WO (`C:\dev\IntelliServiceBeta\project\docs\0023-wo-mnemosyne-wiring-isb.md`) is now unblocked; (c) `contract_dismissed` memory-worthiness — confirm the v1 exclusion is intentional; (d) v2 consolidation/rollup job, already flagged out of scope here.
