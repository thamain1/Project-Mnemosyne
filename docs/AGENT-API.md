# Agent Context & Outcome API

External agent systems (first consumer: IntelliService-ISB's dispatch + contract agents) get a
service-token surface distinct from the hosted MCP (`docs/MCP-DESIGN.md`). Full design: `docs/
WORK-ORDER-AGENT-API.md`. Migration: `0031_agent_client_api.sql`.

## Auth model

- One row per external client in `agent_clients` (`client_slug`, `token_hash` — sha256, plaintext
  never stored), minted via `scripts/provision-agent-client.mjs <slug> "<Display Name>"`.
- Bearer token in the `Authorization` header, verified via `verify_agent_client_token` (service-role
  RPC). Unknown / malformed / inactive tokens all return an identical `401` — no oracle.
- **Narrower trust tier than a hosted-MCP machine token**: an agent_clients token has no scopes array
  and no tool surface — it can reach exactly these two endpoints, nothing else in the app.
- **Demo-vs-prod gate (Jesse, 2026-07-06):** only `dunaway-isb-demo` is minted today. A production
  client token is NOT issued until contract data-use language exists for that engagement — this is a
  hard gate, not a technical limitation.

## Namespace convention

Every agent-sourced memory carries tags: `client:<client_slug>` (always) plus entity tags
`isb-customer:<uuid>` / `isb-tech:<uuid>` (ISB's own UUIDs — Mnemosyne holds no entity rows for them
in v1). `POST /api/agent-outcome` enforces `client:<slug>` must exactly match the authenticated
caller's own slug at the DB layer (`record_agent_outcome`, migration 0031) — independent of the app
code, because cross-client leakage is the one unacceptable failure mode here.

## `POST /api/agent-context` — recall

```
Authorization: Bearer <client token>
{ "customer_id": "<uuid>", "tech_ids": ["<uuid>", ...] }
```
→ `200 { "context": string | null }` — a compact plain-text digest (customer-scoped facts first,
then per-tech facts, newest first), hard-capped at 2000 chars, names/facts only (no IDs in the
prose). Tag-filtered only — **no Gemini embed call** in v1 (the structured tags make semantic search
unnecessary and keep this endpoint fast + free; the deliberate divergence from `/api/recall`).
Rate limit: 60/min per client.

## `POST /api/agent-outcome` — write

```
Authorization: Bearer <client token>
{ "event_type": "...", "summary": "...", "customer_id"?, "customer_name"?, "tech_id"?, "tech_name"?, "ref"? }
```
→ `200 { "ok": true }`. `event_type` allowlist: `dispatch_rejected`, `dispatch_override`,
`contract_won`, `contract_lost`, `contract_dismissed`, `note`. Rate limit: 120/min per client.

**Distill, don't accumulate** (Jesse + Atlas, 2026-07-04): Mnemosyne receives only qualitative
signal, never raw session/operational data (that stays in ISB's own `agent_session_logs`).

- Every call appends exactly one `activity_log` row (`action = agent.<event_type>`) — the durable
  per-client audit trail.
- `dispatch_rejected`, `dispatch_override`, `contract_lost`, and `note` ALSO get a tagged, embedded
  `memory_entries` row (kind `reference`, provenance `agent/<client_slug>/<name>`) — the fact becomes
  recallable context on the next `agent-context` call for that customer/tech. Plain `contract_won` /
  `contract_dismissed` are activity-log only in v1 (no "has notable content" signal exists in the
  fixed request shape to distinguish a notable one).
- Both writes are atomic (`record_agent_outcome`, one transaction) — a memory-insert failure can
  never leave an orphaned activity row.
- **No consolidation/rollup job in this unit.** One memory row per qualifying event. A periodic
  rollup (per customer-tech pair, event rows → one living summary) is the designed v2 — volume math
  says this is years away from mattering at one client.

## Adding a future client

One `scripts/provision-agent-client.mjs <slug> "<Display Name>"` run, one token handoff out-of-band.
No code change.
