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
