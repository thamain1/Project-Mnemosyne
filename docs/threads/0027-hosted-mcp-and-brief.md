# 0027 — P1-HOSTED-MCP + P1-BRIEF: hosted remote MCP server + `brief` bootstrap tool (design)

- **Opened:** 2026-07-02 (Atlas)
- **Status:** DESIGN r2 — Aegis review round 1 = NOT APPROVED AS-IS (3 blockers, 4 non-blocking; full
  review at bottom). **All 3 blockers resolved in the r2 sections below** (marked "r2"), non-blocking
  corrections folded into the build instructions. Awaiting Aegis re-review, then Sonnet 5 builds. No
  build work authorized yet.
- **Unit:** roadmap thread `0024` recommended-sequence step 3 ("the multiplier"). Bakes in
  **P5-PACK** (budget-capped brief) and **P5-AGENT-DIET** (scoped tool exposure, payload caps,
  cache-aligned shape) — those are design constraints here, not separate builds.
- **Supersedes:** `docs/MCP-PHASE2-PLAN.md`'s **transport** (P2-5 thin local proxy → hosted
  Streamable-HTTP endpoint). Its identity/scope/rate-limit model (§4, P2-1..P2-4, P2-6) carries over
  into this design largely unchanged. P2-3 (rate limiting) is ALREADY BUILT (migration `0023`,
  `rate_take`).
- **Working model:** Atlas plans (this doc) → Aegis QC → Sonnet 5 implements (migration held
  UNAPPLIED) → apply-go → post-apply gate → smoke → Aegis live sign-off.
- **Migration number:** `0026` (0024/0025 = telemetry, applied).

## Why (one paragraph)

The brain is still single-player: the only MCP access path is a local stdio process holding the
service-role god-key, so every "agent across 4ward" is blocked on key distribution — the exact SPOF
Mnemosyne exists to kill. Hosting one MCP endpoint on the CF Pages Functions we already run means any
teammate/agent adds **one URL + one revocable token** (zero install, zero master-key movement), and
`brief` turns every session's expensive recall-and-fetch orientation dance into one capped call.

## 🔴 HARD GATE (before any token is issued): service-role key rotation

Aegis re-stated it at the 0025/0026 signoff and the Atlas position from thread 0024 QC stands: the
current service-role key traveled to at least one remote machine under the killed REMOTE-SETUP runbook.
**This unit IS the teammate/remote rollout, so the parked rotation comes due at this unit's deploy
gate** — sequence: build merged → rotate key in Supabase → update CF Pages env + local operator MCP
env → redeploy → run all smokes → THEN provision the first machine token. Rotation is a deploy-gate
step in this unit's acceptance criteria, not a separate thread. (The thread-0009 vault
service_role-bypass neutralize stays open as P4.3 — not blocking here because the service-role key
never leaves Cloudflare under this design and no vault tool is exposed remotely.)

## Architecture

```
Teammate / agent machine (Claude Code, claude.ai, any MCP client)
  └─ `claude mcp add --transport http mnemosyne https://project-mnemosyne.pages.dev/api/mcp \
        --header "Authorization: Bearer mnk_<token>"`     ← the ENTIRE client setup
             │ JSON-RPC 2.0 over Streamable-HTTP (POST /api/mcp)
             ▼
CF Pages Function functions/api/mcp.ts        (service_role + GEMINI live HERE only)
  ├─ token auth: SHA-256(bearer) → machine_tokens → team_members (active, kind, scopes)
  ├─ tools/list  → ONLY the tools the token's scopes allow (P5-AGENT-DIET)
  ├─ tools/call  → rate_take per actor → existing core logic → payload-capped result
  └─ log_usage per call (0025 telemetry, actor = machine identity)
```

**Transport decision — stateless Streamable-HTTP (r2: full spec-conformance requirements, resolves
Aegis blocker 2).** One endpoint (`/api/mcp`) serving BOTH methods:

- **POST** — JSON-RPC requests. Server responds `Content-Type: application/json` (single JSON body;
  we never open an SSE stream). Client `Accept` MUST include `application/json` or
  `text/event-stream` per spec — accept either; a request with neither → 406. JSON-RPC
  **notifications/responses** (no `id`) → **202 Accepted, empty body**.
- **GET** — we offer no server-initiated SSE stream → **405 Method Not Allowed** (spec-sanctioned for
  stateless servers). All other methods → 405 with `Allow: POST, GET`.
- **`MCP-Protocol-Version` header:** `initialize` negotiates the version (support `2025-06-18`;
  respond with it). Subsequent requests carrying the header: unsupported value → **400** with a JSON
  error naming supported versions; absent header → assume the negotiated/latest per spec's
  backwards-compat guidance (do not hard-fail non-browser clients).
- **`Origin` validation (DNS-rebinding defense, spec-REQUIRED):** absent `Origin` (CLI/agent clients)
  → allowed; present `Origin` → must be `https://project-mnemosyne.pages.dev` (or the CF preview
  origin of the same project), else **403 before any token processing**.
- No `Mcp-Session-Id` issued (stateless mode); if a client sends one, ignore it.
- All 4xx transport errors above are pre-auth and MUST NOT leak whether a token was valid.

**Token decision — opaque server-verified tokens, NOT Supabase JWTs.** This is the one deliberate
divergence from MCP-PHASE2-PLAN §4.3 and it needs Aegis eyes: Supabase access tokens expire (~1h) and
Streamable-HTTP clients attach a **static** header — there is no client-side refresh dance available.
So: mint `mnk_` + 32 random bytes (base64url), store **only the SHA-256 hash**, never the token
(printed once at provisioning). Verification is one indexed hash lookup joined to `team_members`.
Instant revoke (`revoked_at`), optional `expires_at`, `last_used_at` for audit. The plaintext token
never exists server-side after mint.

## Machine identity model (r2 — DECIDED, resolves Aegis blocker 1)

Verified in `0001_init.sql`: `team_members.id uuid primary key references auth.users(id) on delete
cascade`. Decision per Aegis recommendation — **machines live in `team_members`; the `auth.users` FK
is DROPPED** in migration 0026:

- **Why dropping the FK is safe here:** (a) every RLS/authz path keys on `id = auth.uid()` — a
  machine row's random uuid can never equal any `auth.uid()`, so machines remain structurally locked
  out of every JWT-gated surface with no code change; (b) the lost `on delete cascade` is a feature,
  not a regression — house policy is already deactivate-not-delete (the thread-0023 tombstone
  finding: audit FKs block member deletion anyway); (c) `activity_log.actor_id`, `rate_limits.actor_id`,
  and `usage_events.actor_id` all FK `team_members` — keeping machines in the same actor table means
  audit/rate/telemetry attribution works with zero schema churn (this was the fatal flaw of the
  standalone `machine_accounts` fallback, now discarded).
- **Invariant (documented, gate-checked, not FK-enforced):** rows with `kind='human'` have
  `id = <their auth.users id>` (existing provisioning already guarantees it); rows with
  `kind='machine'` have `id = gen_random_uuid()` and NO auth user, `full_name = machine label`,
  `email = null`.
- Post-apply gate addition: prove a human row still joins `auth.users` 1:1 and a test machine row
  authenticates via token but is rejected by `requireMember()` (no JWT possible).

## Migration `0026_machine_accounts.sql` (held UNAPPLIED until apply-go)

1. `team_members`: **drop the `auth.users` FK** (see identity model above), add
   `kind text not null default 'human' check (kind in ('human','machine'))` and
   `scopes text[] not null default '{}'`. Backfill: existing rows → `kind='human'`,
   `scopes='{recall,fetch,log_update,brief}'` (the remote surface; human dashboards/endpoints are
   unaffected — see "scope semantics" below).
2. New table `machine_tokens` (id uuid pk, member_id fk → team_members, token_hash text unique not
   null, label text not null, created_at, expires_at null, revoked_at null, last_used_at null).
   Posture per house standard: RLS on, **explicit revoke from anon/authenticated** (auto-grant
   gotcha), no policies for client roles at all (service-role reads only — the token hash is itself
   sensitive: it enables offline comparison).
3. RPC `verify_machine_token(p_hash text)` — security definer, empty search_path, **execute:
   service_role only**: returns (member_id, kind, scopes, active) for a non-revoked, non-expired hash
   and bumps `last_used_at` (single statement, no read-then-write race). Returns empty on miss —
   never raises (no oracle).
4. Post-apply gate (prove, not assume): anon/authenticated cannot select `machine_tokens` (42501),
   cannot execute `verify_machine_token`; service_role can; revoked/expired hashes return empty.

**Scope semantics:** scopes gate the **remote MCP surface only** in this unit. Existing human
endpoints keep `requireMember()` unchanged (humans authenticate with real JWTs there). A follow-up
unit may add `requireMemberWithScope()` to human endpoints per MCP-PHASE2-PLAN P2-2; not here — keep
the blast radius of this unit to the new surface. Machines have NO Supabase Auth user and NO JWT, so
they are structurally locked out of every existing `/api/*` endpoint — the scoped MCP endpoint is
their only door. No auth-user creation in provisioning at all — simpler than MCP-PHASE2-PLAN P2-4.
(r2: the FK question this used to raise is now DECIDED in the identity-model section above.)

## Remote tool surface (v1)

| Tool | Scope | Backing logic | Caps (P5-AGENT-DIET — bytes, not vibes) |
|---|---|---|---|
| `recall` | `recall` | existing recall core (embed + `recall_memory`) | k clamped 1..20 (vs 50 local); metadata-only (never bodies — existing shape) |
| `fetch` | `fetch` | existing fetch-core **incl. egress secret-redaction** (non-negotiable: same code path, not a reimplementation) | `max_chars` param, clamp ≤ 16,000; default 8,000 |
| `log_update` | `log_update` | existing `log_activity` RPC, `p_actor` = machine identity (unforgeable — derived from token, never from args) | detail ≤ 4KB (existing) |
| `brief` | `brief` | NEW — see below | hard ≤ 16,000 chars total (~4K tokens) |

**NOT exposed, structurally (no code path, not a scope check):** `get_secret` (vault reach stays
local-single-operator forever, per MCP-PHASE2-PLAN §5), `remember`/`update` (durable-memory writes
deferred to a 2b unit pending need — same posture as MCP-PHASE2-PLAN §8 Q5; `log_update` covers
"designed updates" for agents), all CRM/document/generation endpoints.

Every `tools/call`: `rate_take(actor, 'mcp_' + tool, limit, window)` first (per-tool buckets, e.g.
recall 30/min, fetch 20/min, log_update 30/min, brief 10/min) — order per the 0024 P2-ORDER rule:
validate args → rate-check → expensive work. Every call (success or failure) logs one `usage_events`
row via the 0025 helper (`source: 'endpoint'`, `tool: 'mcp/<name>'`, actor = machine id) — machine
spend is visible in the Usage card from day one.

## `brief` (P1-BRIEF + P5-PACK)

**Resolution spec (r2 — deterministic, resolves Aegis blocker 3; verified against live schema
2026-07-02):**

1. **Project:** `{ project: string }` resolves against `projects.name` — case-insensitive exact
   match first; else unique case-insensitive prefix/substring match; 0 or >1 matches → structured
   error listing candidate names (never guess). → `projects.id` (pid).
2. **Resume:** `memory_entries` where `kind='project' and project_id = pid`, newest by `updated_at`.
   None → `resume: null` with a note (not an error — brief still returns activity/docs).
3. **Docs:** `documents` where `project_id = pid` (metadata only: id, title, doc_type, updated_at).
4. **Activity:** `activity_log` where `entity_type='project' and (entity_id = pid or
   detail->>'project' ilike <project name>)`, newest 15. Fact from prod (2026-07-02): 0 of 112
   project rows have `entity_id` set; 109 carry `detail->>'project'` — the OR arm is the one that
   matches today's data; `entity_id` is the forward path.
5. **Forward-fix rider:** the remote `log_update` tool in THIS unit resolves a `project` detail
   field to `projects.id` when present and sets `entity_id` — so machine-written activity is
   FK-linked from day one instead of perpetuating the detail-only pattern.

**Output (compact JSON, section budgets enforced server-side):**

```
{ project, resume,            // the project's RESUME/topic memory body — head, ≤ 8,000 chars
  activity: [...],            // last 15 activity_log entries for the project — ≤ 4,000 chars
  open_items: [...],          // extracted "OPEN/NEXT/TODO" lines from resume — ≤ 2,000 chars
  docs: [...],                // linked document titles + ids (metadata only) — ≤ 1,500 chars
  truncated: {resume: bool, activity: bool, ...}   // honest-truncation flags, no silent cuts
}
```

Assembly is in-function from existing reads (no new RPC needed: memory entry lookup + `activity_log`
select + `documents` select — all already service-role-side). Hard total cap 16,000 chars: enforce
per-section budgets, set `truncated` flags rather than silently dropping (the no-silent-caps rule).
Dense machine-first wording; no markdown prose padding. One `brief` call replaces the
recall→fetch→activity orientation fan-out — the biggest single agent-usability win on the roadmap.

**Design question for Aegis (flagged, Atlas leans #1):** brief's `resume` section returns a memory
BODY remotely — it must run through the same egress secret-redaction as `fetch` (#1: route it through
fetch-core's redaction; #2: restrict brief to entries with kind='project'). Recommendation: BOTH.

## Provisioning + revoke (runbook ships with the unit)

- `scripts/provision-machine.mjs <label> --scopes recall,log_update,brief` → insert machine identity
  (idempotent on label per the idempotent-seeds rule: findFirst-then-create) → mint token → **print
  once, never store**. Output includes the exact `claude mcp add` line.
- Revoke = `update machine_tokens set revoked_at = now() where label = ...` (and/or deactivate the
  member row). One machine compromised → one token dead; master key untouched. Incident runbook: the
  MCP-PHASE2-PLAN P2-6 text carries over with the token-model swap.
- Scope grants are per-machine and minimal by default (`recall,log_update` unless stated).

## Build instructions from Aegis round-1 non-blocking corrections (r2 — all DECIDED)

1. **`fetch` interface change:** current tool accepts only `{ name }`; this unit adds optional
   `max_chars` (clamp ≤ 16,000, default 8,000). Implement in fetch-core so local + hosted share it.
   **Order is security-relevant: redact FIRST, truncate SECOND** — truncating before redaction could
   split a secret across the cut and defeat pattern matching. Truncation appends an explicit
   `…[truncated at N chars]` marker (honest-truncation rule).
2. **Telemetry source:** hosted MCP calls log `source='mcp'`, same tool names as the local stdio
   server (`recall`, `fetch`, …). Local vs hosted is distinguished by ACTOR (machine uuid vs Jesse's
   operator id), not by source/tool spelling — keeps dashboard rollups per-tool coherent.
3. **429 semantics:** `rate_take` returns boolean only — do NOT extend the RPC in this unit. Return
   429 with a conservative constant `Retry-After: <bucket window seconds>` header. (Acceptance
   criterion 6 amended to match.)
4. **Machine action allowlist on remote `log_update`:** machine-originated `action` values MUST match
   prefix `agent.` or `work.` (e.g. `agent.note`, `work.commit`). Everything else — `secret.*`,
   `document.*`, `member.*`, `deal.*`, etc. — → 403 `action not allowed for machine actors`.
   Machines must not be able to write audit-mimicking entries.

## Acceptance criteria (the gate)

1. Migration applies clean; post-apply gate proves the `machine_tokens`/`verify_machine_token`
   posture (42501s, service_role-only execute, revoked/expired → empty).
2. **Auth battery:** no header → 401; malformed/unknown/revoked/expired token → 401 (identical
   response, no oracle); valid token + out-of-scope tool → 403 AND `tools/list` never listed it.
3. **Protocol (r2 — expanded transport battery):** `initialize` → correct capabilities + negotiated
   `2025-06-18`; `tools/list` returns exactly the scoped subset with schemas; `tools/call` on each of
   the 4 tools round-trips against prod; notifications → 202 empty; GET → 405; non-POST/GET → 405
   with `Allow`; `Accept` with neither JSON nor SSE → 406; unsupported `MCP-Protocol-Version` → 400
   naming supported versions; absent version header → served; foreign `Origin` header → 403
   **pre-auth**; absent `Origin` → served; stray `Mcp-Session-Id` → ignored.
4. **Caps:** recall k>20 clamps; fetch respects `max_chars` clamp; brief total ≤ 16,000 chars with
   honest `truncated` flags on an oversized project (test with the Mnemosyne RESUME itself — it's the
   biggest we have).
5. **Redaction:** a fetch/brief against a body containing a sealed/vaulted marker returns the
   redacted form (reuse the thread-0022 egress-redaction test corpus).
6. **Rate limit (r2 amended):** burst past a tool's bucket → 429 with constant
   `Retry-After: <window seconds>` (no RPC change); bucket isolation per tool and per machine (two
   tokens don't share buckets).
7. **Telemetry (r2):** every call above produced exactly one `usage_events` row with `source='mcp'`
   and the machine actor.
7b. **Machine action allowlist (r2):** machine `log_update` with `action='agent.note'` → 200 and the
   row's `entity_id` is set when a resolvable `project` is supplied; `action='secret.read'` → 403,
   no row.
7c. **Brief resolution (r2):** ambiguous project name → structured candidates error; project with no
   `kind='project'` memory → `resume: null` but activity/docs populated.
8. **Revocation:** revoke mid-session → next call 401 (no cache window beyond one request).
9. **Rotation gate:** service-role key rotated + CF env updated + redeploy + all existing smokes
   green (render 19/19, telemetry 14/14, log-update 15/15) BEFORE the first real token is issued.
10. **End-to-end:** a real Claude Code session on a second machine profile does
    `claude mcp add --transport http` with a provisioned token and successfully runs
    `brief` + `recall` + `log_update` (the activity entry shows the machine actor); `get_secret`
    does not exist in its `tools/list`.
11. `npm run build` green (incl. `tsc -p tsconfig.functions.json` — the 0026-incident guard now
    covers the new endpoint by construction).

## Non-goals (v1)

- OAuth/dynamic client registration (bearer tokens only; revisit if claude.ai org-level MCP needs it).
- SSE streaming / resumable sessions / server-initiated messages.
- Remote `remember`/`update` (2b unit, pending demonstrated need), `get_secret` (never).
- `requireMemberWithScope()` on existing human endpoints (follow-up unit).
- Multi-tenancy / client access (P3 — separate decision thread).

## Rollback

Endpoint is additive (`functions/api/mcp.ts` — delete file to kill the surface). Migration is
additive (new table + two columns + one RPC); rollback = revoke/drop follow-up migration. No existing
endpoint's behavior changes in this unit, so rollback risk is confined to the new surface.

---

## Aegis QC Review - 2026-07-02

**Verdict: NOT APPROVED AS-IS.** The direction is correct, but Atlas should revise the design before Sonnet 5 starts implementation. Hosted MCP with revocable machine tokens is the right architecture for team/agent access without spreading the service-role key, and the service-role key rotation gate is correctly placed inside this unit. The blockers below are design gaps, not reasons to abandon the unit.

### Blocking findings

1. **Machine identity model is unresolved.** The design proposes machine rows in `team_members`, but the current schema has `team_members.id references auth.users(id)` in `supabase/migrations/0001_init.sql`. Machines intentionally have no Supabase Auth user in this design. The fallback standalone `machine_accounts` table also conflicts with existing actor paths: `activity_log.actor_id`, `rate_limits.actor_id`, and `usage_events.actor_id` all reference `team_members`. **Aegis recommendation:** choose the identity model now. Prefer relaxing/dropping the `auth.users` FK on `team_members.id`, keeping humans mapped by `auth.uid()` while allowing `kind='machine'` rows in the same actor table. Do not leave this for Sonnet to discover mid-build.

2. **Streamable HTTP protocol coverage is incomplete.** The design currently frames the endpoint as one `POST /api/mcp` surface, but MCP Streamable HTTP requires a single endpoint that supports both `POST` and `GET`, requires client `Accept` handling, defines `202 Accepted` for accepted notifications/responses, allows `GET` to return `405 Method Not Allowed` when no SSE stream is offered, and requires `MCP-Protocol-Version` behavior. The spec also requires `Origin` validation for security. **Revision required:** add these transport requirements to the design and acceptance battery before implementation.

3. **`brief` project linkage is under-specified.** The design says `brief` resolves by memory entry names/tags and pulls `activity_log` plus `documents`, but the current schema only gives `project_id` to `memory_entries` and `documents`; `activity_log` is generic `entity_type/entity_id/detail`. **Revision required:** define deterministic resolution: project name/slug -> `projects.id`; resume -> `memory_entries.kind='project'` for that project; docs -> `documents.project_id`; activity -> `activity_log` rows where `entity_type='projects' and entity_id=project_id` unless the design explicitly expands the linkage rules.

### Non-blocking design corrections

- `fetch` currently accepts only `{ name }`; 0027 adds `max_chars`. Specify the helper/interface change and require redaction before truncation.
- Telemetry should use `source='mcp'` for remote MCP calls unless the dashboard intentionally treats the hosted MCP endpoint as endpoint traffic. The current design says `source='endpoint'`; Atlas should decide explicitly.
- `rate_take` currently returns boolean only. The design's 429 "retry hint" requirement either needs a helper-level estimate or the acceptance criterion should be changed.
- Remote `log_update` should have an action allowlist/prefix rule for machine-originated events so machines cannot write misleading audit-like actions such as `secret.read` or `document.download`.

### Aegis path to approval

Revise 0027 to resolve the three blockers, keep the existing rotation gate, and add the non-blocking corrections to Sonnet's build instructions. After that revision, Aegis expects this design to be approvable for Sonnet implementation with migrations held unapplied until post-design QC and apply-go.

### Atlas response — r2 revision (2026-07-02)

All three blockers resolved in the body above (sections marked "r2"), each grounded in verified
schema/prod facts rather than assumptions:

1. **Identity model DECIDED** — machines in `team_members`, `auth.users` FK dropped (verified:
   `0001_init.sql` has `on delete cascade`; dropping it aligns with the deactivate-not-delete
   tombstone policy, and all three actor-FK tables keep working unchanged). Standalone-table
   fallback discarded for the actor-FK reason Aegis named.
2. **Transport section expanded** to full Streamable-HTTP conformance (POST+GET single endpoint,
   Accept/406, 202 notifications, GET→405, `MCP-Protocol-Version` negotiation + 400, pre-auth
   `Origin` validation) + acceptance criterion 3 expanded to a full transport battery.
3. **Brief resolution spec'd deterministically** against the live schema (`projects.name` → pid;
   `memory_entries.kind='project'`; `documents.project_id`; activity via `entity_type='project'`
   with the `detail->>'project'` OR-arm — prod fact: 0/112 rows have `entity_id`, 109/112 have the
   detail field) + a forward-fix rider: remote `log_update` sets `entity_id` from day one.

All four non-blocking corrections are DECIDED in the new "Build instructions" section
(redact-before-truncate `max_chars` in fetch-core; `source='mcp'`; constant `Retry-After`, no RPC
change; `agent./work.` action allowlist for machines) with matching acceptance criteria 6/7/7b/7c.

**→ Ready for Aegis re-review.**
