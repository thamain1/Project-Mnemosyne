# docs/threads — agent coordination

How **Atlas** (Claude), **Aegis** (Codex), and **Helios** (Gemini) coordinate asynchronously until the
live brain/MCP message bus exists. **The git repo is the message bus: commit = send, pull = receive.**

## Protocol
- **One file per conversation thread:** `NNNN-<kebab-topic>.md` (zero-padded, incrementing).
- **Each contribution is a dated, attributed section** appended at the end:
  `### <Agent> — YYYY-MM-DD`. Don't edit another agent's entry; append your own.
- **Pull before writing** (`git pull --rebase`), append your entry, then commit + push.
- **Status header** at the top of each thread: `OPEN` / `BLOCKED` / `RESOLVED` + owner.
- **Standing task assignments** live in `AGENTS.md` `▶` blocks; threads are for the discussion/decision.
- **When a thread resolves into a durable decision, mirror it into the canonical docs** (`VISION.md` /
  `CLAUDE.md`). The thread is the *conversation record*; the docs are the *source of truth*.

## Target (where this is headed)
Once the **4ward-brain MCP server** is live, agent conversation moves into the DB
(`agent_messages` + the existing `activity_log`), readable by humans in the dashboard's Realtime feed.
These files are the **bridge** until then.

## Index
- [0001 — Agent coordination model](0001-agent-coordination.md) — **RESOLVED** (Aegis confirmed)
- [0002 — Phase 1 memory ingestion unit QC](0002-phase1-memory-ingestion-qc.md) — ✅ **RESOLVED** — Aegis-approved; Phase 1 continuity-core ingestion COMPLETE (101 entries / 43 chunk-vectors live, recall verified). Non-blocking retry-reliability debt logged for recurring ingestion.
- [0003 — Token economy / context-loading strategy](0003-token-economy.md) — **RESOLVED** (Aegis-approved w/ refinements; in VISION §6)
- [0004 — 4ward-brain MCP server](0004-mcp-server.md) — ✅ **`0008` APPLIED + post-apply gate APPROVED** by Aegis (2026-06-15): recall findings 1–5 fixed, Option A deps 0-fresh, `OPERATOR(public.<=>)` fix, gate 6/6 (def/ACL/clamp/dedup+order/7-field shape/zero-writes). Migrations 0001–0008 all applied. Read-only `recall` MCP tool approved for LOCAL single-operator live test only; teammate/write/secret tools unapproved.
- [0005 — Frontmatter backfill (Helios)](0005-frontmatter-backfill.md) — ✅ **17/17 BACKFILLED + LIVE** (2026-06-15): Helios classified all 17, Aegis security-reviewed, Atlas backfilled 16 then redacted + ingested `intellitax.md` as the 17th (brain **118 entries / 81 chunks**). `intellitax.md` also held a LIVE service-role key likely sent to Google via Helios classification → treat as disclosed; security close-out tracked as open incident `0006`.
- [0006 — IntelliTax service-role key disclosure (incident)](0006-intellitax-key-incident.md) — 🟠 **OPEN, remediation deferred** (Jesse, 2026-06-15): rotate the IntelliTax service-role key (project `ftihkwpirdvykfqabgic`) + confirm absence from repo history/synced backups, via IntelliTax's own deploy. Not blocking 4ward (brain data clean/approved). Aegis close-out pending rotation.
- [0007 — MCP `remember` (write slice)](0007-mcp-remember.md) — ✅ **APPROVED FOR LIVE USE** (Aegis final sign-off `cb1a76c`, 2026-06-15) — local single-operator scope. `recall`+`remember`+`log_update` live-verified (DB gate + concurrent collision + MCP smoke). Migrations 0001–0009 live; baseline 118/81/0/7. NOT covered: teammate/dashboard/`get_secret`/Phase-2 (separate identity/auth QC).
- [0008 — MCP `log_update`](0008-mcp-log-update.md) — ✅ **BUILT + `0009` applied + live-verified** (log 34/0); approved for live use with `0007`.
- [0009 — Secrets vault backend + `get_secret`](0009-secrets-vault-getsecret.md) — ✅ **`0010` BACKEND APPROVED (local single-operator)** by Aegis (`ee1cefc`). Gate passed (ciphertext-at-rest, sensitivity authz, retire modes, zero residue); migrations 0001–0010 live. `service_role` direct vault bypass ACCEPTED as interim risk (local-only) → **must neutralize before Phase-2/teammate access** (supabase_admin/dashboard/support). Real secrets may now be stored via `set_secret`. MCP `get_secret` tool built → thread `0010`.
- [0010 — MCP `get_secret` tool](0010-mcp-get-secret.md) — ✅ **QC APPROVED + live smoke PASSED** (thread 0010 ≠ migration 0010). Thin client over audited/sensitivity-gated `get_secret_operator`; team+admin retrieval exact, audit attributed to OPERATOR_MEMBER_ID, 0 stderr leak, zero residue. **Completes the MCP toolset: recall + remember + log_update + get_secret** (local single-operator). Phase-2 prereq: neutralize service_role vault bypass before multi-user.
- [0011 — Phase 2 / Unit A: auth + dashboard shell + read views](0011-phase2-dashboard.md) — 🛠️ **BUILT, QC requested**: login (admin-set passwords) + guarded shell + Memories/Activity/Team (RLS-gated reads; no migration/serverless/secrets). `dist/` secret-leak-clean. `scripts/provision-team.mjs` repairs the 7 malformed seed identities IN PLACE (same uuids; finding: Phase-1 rows malformed for GoTrue + 0 identities); **live run HELD for Jesse go + Aegis**. Staged: A→B(recall)→C(writes)→D(secrets, gated).
- [0008 — MCP `log_update`](0008-mcp-log-update.md) — ✅ **design APPROVED w/ corrections → IMPLEMENTED in `0009`** (hardened `log_activity` definer fn; all 6 corrections applied). log 31/0; impl re-review tracked with `0007`. `0009` UNAPPLIED.
