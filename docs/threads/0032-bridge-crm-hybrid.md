# 0032 — P2-BRIDGE + P2-CRM + P1-HYBRID: lead-gen foundation (design)

- **Opened:** 2026-07-02 (Atlas/Fable)
- **Status:** DESIGN — awaiting Aegis review, then Sonnet 5 builds. No build work authorized yet.
- **Unit:** roadmap thread `0024` recommended-sequence step 4 ("lead-gen foundation, immediately
  useful to the team"). **P5-FETCH-SCOPE rides with HYBRID** per the roadmap. Two small UI riders
  from Jesse's 2026-07-02 concept direction (see "UI riders" — `docs/UIandAgentIdeal.md`,
  `docs/agenticos.PNG`, `docs/conceptUI.PNG`) are folded in WITHOUT expanding scope; the full
  Agentic-OS/Mission-Control vision is explicitly deferred (see "Deferred").
- **Working model:** Atlas plans (this doc) → Aegis QC → Sonnet 5 implements (migration held
  UNAPPLIED) → apply-go → post-apply gate → smoke → Aegis live sign-off.
- **Migration number:** `0027_bridge_crm_hybrid.sql` (0026 = machine accounts, applied).
- **Verified against live schema 2026-07-02:** `clients` = id/name/notes/created_at (lead-gen-naked);
  `contacts` = id/client_id/name/email/role; `deals` = id/client_id/title/stage/amount/currency/
  owner_id/sensitivity/notes/created_at (0 rows today); `memory_entries.project_id` now populated
  (0030); `recall_memory` = pure-vector (0008).

## Why (one paragraph)

Retrieval, generation, CRM, and hosted agent access all exist — but there is **no FK between the
brain and the CRM**, so "everything we know about client X" is unanswerable in one query, and the
prospect-research loop (P2-LOOP, the first unit that plausibly *makes* money) has nothing to ground
itself on. Meanwhile recall is pure-vector and fumbles exactly what lead-gen needs most: exact names,
slugs, invoice/deal refs. This unit is the keystone: link memories↔CRM, upgrade the CRM tables to
lead-gen grade, make recall find exact things, and let `fetch` pull just the section an agent needs.

## Part A — P2-BRIDGE (memories ↔ CRM linkage)

**Schema (migration 0027, additive):**
1. `memory_entries`: add `client_id uuid references clients(id) on delete set null` and
   `deal_id uuid references deals(id) on delete set null` (nullable; `project_id` precedent from
   0030). No link table in v1 — an entry is *about* at most one client/deal in practice; a link
   table is the v2 escape hatch if that assumption breaks (record it in the doc, don't build it).
2. Same two columns on `documents` (which already has `deal_id` — verify; add only what's missing).
3. Indexes: `(client_id)` + `(deal_id)` partial `where ... is not null` on both tables.

**Write paths (service-role RPC posture, house standard):**
- Extend `ingest_memory_entry` + `update_memory` with optional `p_client_id`/`p_deal_id`
  (validated FKs; provenance rules unchanged).
- The local `remember`/`update` MCP cores + hosted surface DO NOT expose these in v1 (agents link
  via `client-brief` flow later in P2-LOOP; humans link via dashboard or scripts). Keeps the blast
  radius to schema+RPC.
- Backfill: NONE in this unit (13 client-contract documents already project-linked by 0030;
  client/deal linkage starts forward — `deals` has 0 rows, nothing to point at yet).

**Read path — the payoff query:** `client_360(p_client_id)` RPC (SECURITY DEFINER, service-role +
member-read via endpoint): one call returning client row + contacts + deals + linked memories
(metadata only) + linked documents (metadata only) + last N activity. This is the grounding call
for P2-LOOP and the "Sales" column of the future Agentic-OS view.

## Part B — P2-CRM (lead-gen-grade fields + stale-deal digest)

**Schema (same migration 0027):**
- `clients`: add `industry text`, `website text`, `source text` (check: referral/inbound/outbound/
  event/other), `status text` (check: prospect/active/dormant/lost) default 'prospect'.
- `contacts`: add `phone text`, `linkedin text`, `title text`.
- `deals`: add `next_action text`, `follow_up_date date`, `expected_close date`,
  `updated_at timestamptz not null default now()` (+ touch trigger, matching memory_entries'
  pattern).
- Upsert RPCs (`upsert_client`/`upsert_deal`/`upsert_contact` endpoints exist from 0015) gain the
  new optional params; dashboard forms gain the fields (small form edits, not a redesign).

**Stale-deal digest (cheapest revenue-protecting feature on the list):**
- `pg_cron` daily job (Supabase-native): deals in an open stage with no activity_log entry
  referencing them in 14 days AND (`follow_up_date` null or past) → ONE digest `activity_log` entry
  (action `crm.stale_deals`, detail = list of deal titles + days-stale). No email in v1 — the
  Activity feed + morning `brief` surface it (brief's open_items gains a "stale deals" line when
  the digest row is <24h old).
- Idempotent: the job checks for an existing digest row for today before writing.

## Part C — P1-HYBRID (+ P5-FETCH-SCOPE + brief name-normalization)

**Hybrid recall (same migration adds the FTS column):**
- `memory_entries`: add generated column `fts tsvector` = `to_tsvector('english', title || ' ' ||
  name || ' ' || body)` STORED + GIN index. (Chunks stay vector-only in v1 — entry-level FTS
  covers the exact-token cases; chunk FTS is a data-size decision for later.)
- `recall_memory` v2: run vector top-K and FTS top-K, fuse with **reciprocal-rank fusion**
  (k=60 constant), add optional filters `p_kind`, `p_project_id`, `p_client_id`, `p_deal_id`
  (the bridge columns immediately pay for themselves) + a mild recency boost
  (multiply RRF score by `1 + 0.1 * exp(-age_days/90)` — tune numbers at build, document choice).
  Same return shape + a `matched_via text` field ('vector'|'fts'|'both') for honesty/debugging.
- Local + hosted `recall` tools gain optional `kind`/`project`/`client` filter args (hosted keeps
  k≤20 cap; schema-declared AND runtime-clamped, per the 0027 lesson).

**P5-FETCH-SCOPE:** `fetch` gains optional `heading text` — return only the markdown section whose
heading matches (case-insensitive substring, first match; not-found → structured error listing the
entry's headings — never guess, ≤50 headings). Combines with existing `max_chars`. **Redaction still
runs on the FULL body BEFORE sectioning** (a secret straddling a section boundary must not survive
slicing — same rationale as redact-before-truncate).

**brief name-normalization (closes the exec-pro finding):** normalize BOTH the input and
`projects.name` to slug form (`lower`, non-alnum→`-`, collapse) for the FK match, so
`intellioptics-2-5` hits project "IntelliOptics 2.5" via the FK path (docs/activity populate).
Exact-name fallback semantics unchanged. Add the exec-pro repro as a smoke case.

## UI riders (Jesse concept direction, 2026-07-02 — bounded, frontend-only)

1. **Animate the node cloud (do in THIS unit):** the Memories force-graph gets continuous idle
   motion (`d3AlphaDecay`≈0.01–0.02, `d3VelocityDecay` tuned, engine never fully sleeps) + directed
   link particles on hover/selection + smooth zoom-to-node on click. `react-force-graph-2d` supports
   all of this natively — hours, zero schema. ALSO: bridge edges (memory→client, memory→deal) join
   the graph as new edge types with distinct colors — the bridge makes the cloud structurally
   richer, which is the real "alive" effect.
2. **Vitals strip (small):** a compact header strip on the dashboard — 7-day calls, tokens, bytes
   (one capped `usage_events` select, reusing the Activity card's aggregation), active machines
   count (`machine_tokens` not revoked, via a new member-readable count RPC or the existing member
   SELECT posture — Sonnet verify read path; if `machine_tokens` must stay service-role-only,
   surface the count through an endpoint instead). This is the first sliver of the V.A.U.L.T.
   "System Vitals" rail, built only from data that already flows.

## Deferred (recorded so the vision doesn't evaporate — NOT this unit)

- **Mission-Control dashboard skin** (HUD layout: directives rail from brief open-items, activity
  ticker, command deck) — next UI unit (P6 reframed); needs no new data, pure frontend.
- **AGENTIC-OS unit** (skills/automations registry + dispatch cards à la `agenticos.PNG`) — gated
  on **P1-BUS** (`agent_messages`); dispatch = work-order rows agents poll, NEVER web-triggered
  shell execution (governance boundary, stated deliberately).
- Browser-hosted MCP clients / CORS (from 0027 non-goals); chunk-level FTS; link-table bridge v2.

## Acceptance criteria (the gate)

1. Migration applies clean; post-apply gate proves: new columns + FKs + checks exist; RLS posture
   unchanged (spot 42501s on direct client writes to the new columns); `fts` GIN index used
   (EXPLAIN on an FTS probe).
2. **Bridge:** ingest + update RPCs accept/validate client_id/deal_id (bad FK → clean error);
   `client_360` returns the full shape for a fixture client (client+contacts+deals+memories+docs+
   activity) and enforces member-auth at its endpoint.
3. **CRM:** upsert RPCs round-trip the new fields; dashboard forms save them; a fixture stale deal
   → exactly one digest activity row; re-run same day → no duplicate.
4. **Hybrid:** a query for an exact slug (e.g. `mnk_` or `0027`) that pure-vector missed ranks it
   top-3 via FTS arm; a semantic query still works; filters restrict correctly; `matched_via`
   populated; hosted k-cap still clamps.
5. **Fetch-scope:** `heading` returns just that section (redacted); unknown heading → structured
   heading-list error; secret straddling a section boundary never leaks (fixture).
6. **Brief:** `brief("intellioptics-2-5")` now resolves via `projects_fk` with docs/activity
   populated (the exec-pro repro); display-name input still works; fallback untouched for
   non-project entries.
7. **UI riders:** node cloud visibly animates idle + particles on selection (screenshot/video for
   Aegis); bridge edges render with legend; vitals strip shows real numbers matching a direct query.
8. `npm run build` green (incl. functions typecheck); all existing smokes stay green (render 19/19,
   telemetry 14/14, log-update 15/15, hosted MCP 60/60); new checks land in a
   `scripts/smoke-bridge-crm-hybrid.mjs` battery + hosted-MCP additions where surface changed.
9. Migration held UNAPPLIED until Aegis post-build QC + Jesse apply-go (0024 standing rule: no push
   of hard-dependent code before apply — Sonnet: `recall_memory` v2 is `create or replace`, so old
   deployed code keeps working against the new function ONLY if the signature stays
   backward-compatible; new optional params must have defaults. Verify both directions before push
   ordering is decided; state the order in the build notes).

## Rollback

Additive columns/index/RPC-params; `recall_memory` v2 is `create or replace` with defaulted params
(old callers unaffected); cron job removable with one `cron.unschedule`. UI riders are frontend-only
commits. Rollback = follow-up migration dropping additions; no data destruction anywhere.

---

## Aegis Design Review - 2026-07-02

**Verdict: NOT APPROVED AS-IS.** The unit is the right next move and the scope is mostly well-shaped, but Sonnet should not build from this design until the two blocking contract gaps below are resolved. Both are design-level fixes; they do not require abandoning the unit.

### Blocking findings

1. **Hybrid recall RPC contract is not implementable/backward-compatible as written.** Existing `public.recall_memory(query_embedding vector(768), match_count int default 8)` takes only an embedding. The proposed FTS arm needs the original text query, but the design does not add a text-query parameter. Also, adding optional/defaulted filter parameters to `recall_memory` does not safely `create or replace` the existing two-argument function; PostgreSQL function identity is argument-type based, so this can create an overload while the old function remains, or create ambiguous two-argument dispatch. Required revision: define an explicit migration/deploy contract. Preferred: create a new service-role-only `recall_memory_hybrid(p_query text, p_embedding vector(768), p_match_count int default 8, p_kind text default null, p_project_id uuid default null, p_client_id uuid default null, p_deal_id uuid default null)` and update local/hosted recall callers to use it after apply. Keep the old `recall_memory(vector,int)` during the deploy window, or make it a wrapper only after callers have moved. Acceptance must prove old deployed code still works until push/deploy order is complete.

2. **`client_360` auth/grant posture is ambiguous.** The design says `SECURITY DEFINER, service-role + member-read via endpoint`, but those are different exposure models. A SECURITY DEFINER function in `public` gets PUBLIC execute by default unless revoked, and it bypasses RLS, so this must be exact before implementation. Required revision: choose one path. Preferred for this repo's existing house pattern: `client_360` is service-role-only, empty `search_path`, all identifiers fully qualified, `EXECUTE` revoked from `public/anon/authenticated`, granted only to `service_role`, and exposed through a JWT endpoint that verifies active team membership before calling it. If Atlas wants direct authenticated RPC instead, the function must explicitly check `(select auth.uid())` is an active team member, revoke `public/anon`, grant only `authenticated`, and smoke-test anon/non-member denial.

### Required design clarifications before build

- **Stale-deal cron needs an exact idempotent implementation plan.** Specify whether `pg_cron` is already enabled or migration 0027 enables it, the stable job name, unschedule/reschedule behavior for reruns, and the function/run context. The digest should use an explicit system actor if available, or intentionally document `actor_id = null`. The stale predicate should be exact: open stages only, `activity_log.entity_type='deals' and entity_id=deals.id`, no duplicate digest for the same calendar day.
- **Update all three CRM write paths.** 0032 correctly names `upsert_client`/`upsert_deal` and the dashboard forms, but `upsert_contact` already exists in migration 0017 and endpoint `functions/api/upsert-contact.ts`. The contact RPC, endpoint strict parser, frontend form, and smoke-contact coverage must all accept/round-trip `phone`, `linkedin`, and `title`.
- **Bridge RPC history/audit posture.** Extending `update_memory` with `client_id`/`deal_id` changes link metadata that is currently outside the memory update surface. State whether `memory_versions` should snapshot prior link fields or whether audit via `log_activity` is sufficient. Also update the payload allowlist and preserve optimistic concurrency.
- **Fetch heading error output must be redacted.** The design correctly requires redaction before sectioning. Apply the same discipline to the unknown-heading response that lists available headings; headings are user-controlled text and can contain secrets.

### Non-blocking notes

- `documents.deal_id` already exists from migration 0015; the design's "verify; add only what's missing" note is correct and should remain binding.
- The FTS generated column is acceptable in principle, but post-build QC should look at migration cost and the EXPLAIN plan. If table growth is material, a trigger-maintained `fts` column may be safer than a table rewrite from a stored generated column.
- The UI riders are acceptable only as bounded frontend work. Keep Mission-Control/Agentic-OS out of this unit as written.
- The vitals strip must not loosen `machine_tokens` read exposure. Use a service-role endpoint/count RPC if direct member SELECT is not already safe.

### Path to approval

Revise 0032 to resolve the two blockers and add the required clarifications as binding build notes. After that, Aegis expects this design to be approvable for Sonnet implementation with migration 0027 held unapplied until post-build QC and Jesse apply-go.
