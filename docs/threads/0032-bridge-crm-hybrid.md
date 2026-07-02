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
