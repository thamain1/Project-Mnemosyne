# 0032 — P2-BRIDGE + P2-CRM + P1-HYBRID: lead-gen foundation (design)

- **Opened:** 2026-07-02 (Atlas/Fable)
- **Status:** 🟡 **FIX ROUND COMPLETE (Sonnet 5, 2026-07-02) — AWAITING AEGIS RE-QC.**
  History: r1 = NOT APPROVED (2 blockers) → r2 resolved all → approved → Sonnet built → Aegis
  post-build QC = NOT APPROVED (1 blocker: `ingest_memory_entry` link-wipe on re-ingest) → Fable
  fix-round decisions (binding) → Sonnet executed the fix round. Both design reviews, the post-build
  QC, Fable's fix-round decisions, and Sonnet's implementation + fix-round reports are all appended at
  the end of this doc. Migration `0027_bridge_crm_hybrid.sql` is **written but UNAPPLIED** — still
  gated behind Aegis re-QC + Jesse's explicit apply-go, per the standing 0024 rule. Nothing pushed.
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
- **Linkage audit posture (r2, per Aegis clarification #3 — DECIDED):** `memory_versions` stays a
  CONTENT history — its schema is unchanged and it does not snapshot link fields. Linkage changes
  are audited via `log_activity` (action `memory.link`, detail = `{entry_name, field:
  'client_id'|'deal_id', old, new}`) written inside `update_memory` when a link param actually
  changes a value. The `update_memory` payload allowlist gains the two params; **optimistic
  concurrency (`expected_updated_at`) applies to link-only updates exactly as to content updates** —
  a link change bumps `updated_at`.
- The local `remember`/`update` MCP cores + hosted surface DO NOT expose these in v1 (agents link
  via `client-brief` flow later in P2-LOOP; humans link via dashboard or scripts). Keeps the blast
  radius to schema+RPC.
- Backfill: NONE in this unit (13 client-contract documents already project-linked by 0030;
  client/deal linkage starts forward — `deals` has 0 rows, nothing to point at yet).

**Read path — the payoff query (r2, resolves Aegis blocker 2 — posture now EXACT, Aegis-preferred
house pattern):** `client_360(p_client_id uuid)` RPC:
- `SECURITY DEFINER`, `set search_path = ''`, all identifiers fully schema-qualified.
- `REVOKE EXECUTE ... FROM public, anon, authenticated; GRANT EXECUTE ... TO service_role;` —
  **service-role-only**, exactly like `verify_machine_token`/`log_usage`.
- Exposed to humans ONLY via a new JWT endpoint `functions/api/client-360.ts` using the existing
  `requireMember()` gate (active team member) before calling the RPC with the service client.
- Returns one JSON object: client row + contacts + deals + linked memories (metadata only, never
  bodies) + linked documents (metadata only) + last N=20 activity rows for the client/deals.
- Acceptance additions: anon → 401, non-member JWT → 403 at the endpoint; direct RPC execute as
  anon/authenticated → permission denied (prove 42501-class, not assume).
This is the grounding call for P2-LOOP and the "Sales" column of the future Agentic-OS view.

## Part B — P2-CRM (lead-gen-grade fields + stale-deal digest)

**Schema (same migration 0027):**
- `clients`: add `industry text`, `website text`, `source text` (check: referral/inbound/outbound/
  event/other), `status text` (check: prospect/active/dormant/lost) default 'prospect'.
- `contacts`: add `phone text`, `linkedin text`, `title text`.
- `deals`: add `next_action text`, `follow_up_date date`, `expected_close date`,
  `updated_at timestamptz not null default now()` (+ touch trigger, matching memory_entries'
  pattern).
- **All THREE CRM write paths (r2, per Aegis clarification #2):** `upsert_client`, `upsert_deal`,
  AND `upsert_contact` (RPC from 0017 + endpoint `functions/api/upsert-contact.ts`) gain the new
  optional params — RPC signature, endpoint strict-parser allowlist, dashboard form, and the
  corresponding smoke (`smoke-crm.mjs` / `smoke-contact.mjs`) coverage, all four layers per path.

**Stale-deal digest (r2 — exact implementation plan per Aegis clarification #1):**
- **Extension:** Sonnet verifies `pg_cron` availability first (`list_extensions`); migration 0027
  runs `create extension if not exists pg_cron` (Supabase-supported). If unavailable on this plan,
  STOP and surface — do not substitute a client-side scheduler silently.
- **Function:** `run_stale_deals_digest()` — definer, empty search_path, service context,
  service-role-only execute. Predicate, exact: `deals.stage` in the OPEN set (Sonnet: derive the
  open set from 0015's actual stage check constraint — do not invent stage names) AND no
  `activity_log` row referencing the deal in 14 days (**Sonnet: verify the real convention the
  existing deal write-paths use for `entity_type`/`entity_id` — match what upsert-deal actually
  writes, not an assumed literal**) AND (`follow_up_date` is null or < current_date).
- **Digest row:** ONE `activity_log` entry via `log_activity`, action `crm.stale_deals`,
  `actor_id = null` (no system actor exists — documented deliberately), detail =
  `{source:'cron', digest_date: current_date, deals:[{title, days_stale}...]}`.
- **Same-day idempotency:** the function first checks for an existing `crm.stale_deals` row with
  `detail->>'digest_date' = current_date` → returns without writing.
- **Job:** stable name `mnemosyne_stale_deals_daily`, schedule `0 12 * * *` (07:00 ET); migration
  unschedules-if-exists then schedules (re-runnable). Rollback = `cron.unschedule` by name.
- No email in v1 — the Activity feed + `brief` surface it (brief's open_items gains a "stale deals"
  line when a digest row from the last 24h exists).

## Part C — P1-HYBRID (+ P5-FETCH-SCOPE + brief name-normalization)

**Hybrid recall (r2, resolves Aegis blocker 1 — the RPC contract is now a NEW function, not an
in-place replace; the old function is untouched during the deploy window):**
- `memory_entries`: add generated column `fts tsvector` = `to_tsvector('english', title || ' ' ||
  name || ' ' || body)` STORED + GIN index. (Chunks stay vector-only in v1. Table is small today
  (~70 entries), so the STORED-column table rewrite is trivial — Sonnet: confirm row count +
  migration duration at build and record the EXPLAIN plan of an FTS probe per the Aegis note; if
  this table were large the alternative is a trigger-maintained column, not needed now.)
- **NEW RPC `recall_memory_hybrid(p_query text, p_embedding vector(768), p_match_count int
  default 8, p_kind text default null, p_project_id uuid default null, p_client_id uuid default
  null, p_deal_id uuid default null)`** — service-role-only execute (revoke public/anon/
  authenticated), definer, empty search_path. `p_query` is the RAW text (the missing piece Aegis
  caught: FTS needs the text, embeddings can't be un-embedded). Runs vector top-K + FTS top-K
  (`websearch_to_tsquery`), fuses with **reciprocal-rank fusion** (k=60), applies filters, applies
  a mild recency boost (`* (1 + 0.1 * exp(-age_days/90))` — tune at build, document the choice).
  Same return shape as today PLUS `matched_via text` ('vector'|'fts'|'both').
- **`recall_memory(vector,int)` is NOT touched in this unit** — no replace, no overload, no wrapper.
  Deploy contract (0024 rule, explicit): apply migration 0027 (creates the NEW function; deployed
  old code keeps calling the old one, unaffected) → THEN push the code that switches local + hosted
  recall callers to `recall_memory_hybrid`. Old-function retirement = a later follow-up migration
  once telemetry shows zero callers (tool names in `usage_events` make this checkable).
- Local + hosted `recall` tools gain optional `kind`/`project`/`client` filter args (hosted keeps
  k≤20 cap; schema-declared AND runtime-clamped, per the 0027 lesson).

**P5-FETCH-SCOPE:** `fetch` gains optional `heading text` — return only the markdown section whose
heading matches (case-insensitive substring, first match; not-found → structured error listing the
entry's headings — never guess, ≤50 headings). Combines with existing `max_chars`. **Redaction still
runs on the FULL body BEFORE sectioning** (a secret straddling a section boundary must not survive
slicing — same rationale as redact-before-truncate). **(r2, per Aegis clarification #4): the
unknown-heading error's heading LIST is extracted from the already-redacted body** — headings are
user-controlled text and can themselves contain secrets; the error path gets the same discipline as
the success path.

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
2. **Bridge (r2):** ingest + update RPCs accept/validate client_id/deal_id (bad FK → clean error);
   a link change writes a `memory.link` activity row with old/new and bumps `updated_at`
   (stale `expected_updated_at` on a link-only update → concurrency error); `client_360` returns
   the full shape for a fixture client and its endpoint enforces anon→401 / non-member→403; direct
   `client_360` execute as anon/authenticated → denied.
3. **CRM (r2):** ALL THREE upsert RPCs (client/deal/contact) round-trip the new fields through RPC +
   endpoint parser + form; a fixture stale deal → exactly one digest activity row with
   `detail->>'digest_date'` = today; second run same day → no duplicate; `cron.job` shows exactly one
   `mnemosyne_stale_deals_daily` after a migration re-run.
4. **Hybrid (r2):** a query for an exact slug (e.g. `mnk_` or `0027`) that pure-vector missed ranks
   it top-3 via FTS arm; a semantic query still works; filters restrict correctly; `matched_via`
   populated; hosted k-cap still clamps. **Contract proofs:** after apply and BEFORE the code push,
   the OLD `recall_memory(vector,int)` still returns correct results (deployed code unaffected);
   `recall_memory_hybrid` execute denied to anon/authenticated; after the code push, `usage_events`
   shows recall traffic and a follow-up check confirms which function names are still called.
5. **Fetch-scope (r2):** `heading` returns just that section (redacted); unknown heading →
   structured heading-list error **whose list is itself redacted** (fixture: a heading containing a
   secret pattern); secret straddling a section boundary never leaks (fixture).
6. **Brief:** `brief("intellioptics-2-5")` now resolves via `projects_fk` with docs/activity
   populated (the exec-pro repro); display-name input still works; fallback untouched for
   non-project entries.
7. **UI riders:** node cloud visibly animates idle + particles on selection (screenshot/video for
   Aegis); bridge edges render with legend; vitals strip shows real numbers matching a direct query.
8. `npm run build` green (incl. functions typecheck); all existing smokes stay green (render 19/19,
   telemetry 14/14, log-update 15/15, hosted MCP 60/60); new checks land in a
   `scripts/smoke-bridge-crm-hybrid.mjs` battery + hosted-MCP additions where surface changed.
9. Migration held UNAPPLIED until Aegis post-build QC + Jesse apply-go (0024 standing rule: no push
   of hard-dependent code before apply). **(r2 wording, binding per the Aegis re-review):** the
   migration CREATES the new `recall_memory_hybrid` — the existing `recall_memory(vector,int)` is
   NOT replaced/overloaded/wrapped in this unit, so deployed old code is untouched by apply. Deploy
   order: apply 0027 → prove old function still serves deployed code → push the caller switch.

## Rollback

Additive columns/index/new-RPC-only (r2: `recall_memory_hybrid` is a NEW function; the old
`recall_memory(vector,int)` is untouched, so rolling back the new one cannot affect deployed
callers); cron job removable with one `cron.unschedule`. UI riders are frontend-only commits.
Rollback = follow-up migration dropping additions; no data destruction anywhere.

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

### Atlas response — r2 revision (2026-07-02)

Both blockers accepted and resolved in the body (sections marked "r2"); all four clarifications are
now binding, decided build notes — nothing left implicit:

1. **Recall contract:** NEW `recall_memory_hybrid(p_query text, p_embedding, ...)` exactly per
   Aegis's preferred shape — the text-query parameter Aegis caught missing is the first param; the
   old `recall_memory(vector,int)` is untouched (no replace/overload/wrapper) with an explicit
   apply-then-push deploy contract and a telemetry-checkable retirement path. Acceptance 4 gains the
   old-function-still-works proof.
2. **`client_360` posture:** service-role-only definer (empty search_path, fully qualified, revoke
   public/anon/authenticated) behind a `requireMember()` JWT endpoint — the house pattern verbatim.
   Acceptance 2 gains the denial proofs.
3. Cron plan is now exact (extension check, function context, derived open-stage set, verified
   entity convention — flagged for Sonnet to read the real write-path, not assume — null-actor
   documented, digest_date dedup, stable job name, re-runnable schedule).
4. All three CRM write paths through all four layers (RPC/parser/form/smoke), `upsert_contact`
   included.
5. Linkage audit DECIDED: `memory_versions` stays content-only; `memory.link` activity rows carry
   old/new; allowlist + optimistic concurrency extended to link params.
6. Fetch unknown-heading list extracted from the redacted body; fixture added.

Non-blocking notes bound into the doc as written (documents.deal_id verify-first stands; FTS
EXPLAIN + migration-cost check recorded in the hybrid section; UI riders stay bounded; vitals strip
must not loosen `machine_tokens` exposure — endpoint fallback already specified).

**→ Ready for Aegis re-review.**

---

## Aegis Design Re-Review - 2026-07-02

**Verdict: DESIGN APPROVED FOR SONNET 5 IMPLEMENTATION.** Atlas r2 resolves both Aegis blockers and folds the four required clarifications into binding build notes. Sonnet may implement against r2 with migration `0027_bridge_crm_hybrid.sql` held unapplied until Aegis post-build QC and Jesse apply-go.

### Resolved blockers

1. **Hybrid recall contract resolved.** r2 creates a new `recall_memory_hybrid(p_query text, p_embedding vector(768), ...)` RPC instead of replacing or overloading `recall_memory(vector,int)`. This supplies the raw text needed for FTS, avoids PostgreSQL function identity ambiguity, and preserves the old function for the deploy window. The apply-then-push contract and old-function-still-works proof are now explicit.

2. **`client_360` exposure model resolved.** r2 uses the house pattern: service-role-only SECURITY DEFINER RPC with empty `search_path`, fully qualified identifiers, public/anon/authenticated execute revoked, and a JWT endpoint guarded by `requireMember()` before the service client calls the RPC. This is sufficient for design approval.

### Required implementation gate notes

- **r2 overrides stale r1 wording.** The acceptance/rollback section still contains old phrasing about `recall_memory` v2 being `create or replace` with defaulted params. Sonnet must implement the r2 contract: create `recall_memory_hybrid`, do not replace/overload/wrap the existing `recall_memory(vector,int)` in this unit. If Atlas cleans the wording before handoff, good; if not, this Aegis ruling is binding.
- The stale-deal cron gate must prove exactly one `mnemosyne_stale_deals_daily` job after migration rerun and no duplicate digest for the same `digest_date`.
- All three CRM write paths must be updated: `upsert_client`, `upsert_deal`, and `upsert_contact`, including endpoint strict parsers, dashboard forms, and smokes.
- Fetch heading-list errors must be generated from the already-redacted body, not raw headings.
- Vitals must not loosen `machine_tokens` read exposure; use a service-role endpoint/RPC if needed.

### Aegis handoff

Proceed to Sonnet 5 implementation against r2. Aegis will block post-build if the old `recall_memory(vector,int)` is modified in this unit, if `client_360` is directly executable by anon/authenticated roles, if migration 0027 is applied or pushed out of order, or if the new smoke battery does not prove the hybrid/bridge/CRM/fetch/brief/UI gates.

---

## Sonnet 5 Implementation Report — 2026-07-02

**All 9 acceptance criteria built against r2. Migration held UNAPPLIED as required.**

**Migration `supabase/migrations/0027_bridge_crm_hybrid.sql`** (new, single file, additive-only):
Bridge (client_id/deal_id on memory_entries+documents, partial indexes, ingest/update_memory
extended, `memory.link` audit rows on link changes, optimistic concurrency unchanged, `client_360`
service-role-only per house pattern), CRM (industry/website/source/status on clients; phone/
linkedin/title on contacts; next_action/follow_up_date/expected_close/updated_at+trigger on deals;
all three upsert RPCs extended; `run_stale_deals_digest()` + `pg_cron` job
`mnemosyne_stale_deals_daily` at `0 12 * * *`, same-day idempotent), Hybrid (`fts` generated column +
GIN index, NEW `recall_memory_hybrid` RPC — `recall_memory(vector,int)` untouched, RRF k=60 fusion +
recency boost).

Two implementation decisions not spelled out verbatim in the design, documented in the migration's
header comment: (1) `log_activity` gets a minimal null-actor carve-out scoped by exact string match
to `p_action = 'crm.stale_deals'` only — no system actor row exists yet; (2) the stale-deals digest
list is encoded as a JSON-string `deals_json` value (not a nested array) to satisfy `log_activity`'s
existing flat-detail constraint without weakening it for any other caller.

**Code (all committed, none deployed until migration applies):** `functions/api/client-360.ts`,
`functions/api/vitals.ts` (new); `functions/_lib/brief.ts` (slug-normalization fix, stale-deal
surfacing), `functions/api/mcp.ts`, `functions/api/upsert-{client,deal,contact}.ts`,
`mcp/lib/{recall,fetch}-core.mjs` (+`.d.mts`), `mcp/server.mjs` (modified). `recall-core.mjs`
additionally carries a runtime fallback (hybrid RPC → old RPC on a missing-function error) as a
safety net for the local stdio server specifically, since it has no push-gate the way the hosted
endpoint does — proven in `mcp/test-recall.mjs`.

**UI riders:** `src/components/MemoryGraph.tsx` (idle animation, hover/selection particles,
zoom-to-node, client/deal bridge-edge rendering), `src/components/VitalsStrip.tsx` (new) +
`src/components/AppShell.tsx`, `src/pages/{CRM,Memories}.tsx`.

**Verification (2026-07-02, this build):**
- `npm run build` — green (`tsc -b`, `tsc -p tsconfig.functions.json`, `vite build`).
- All `mcp/test-*.mjs` green, no regressions: fetch 75/75, recall 39/39, remember 60/60,
  update 42/42, usage 5/5, getsecret 17/17, log all passing.
- `node --check` clean on every new/modified script.
- `scripts/smoke-bridge-crm-hybrid.mjs` (new) written for live post-apply verification: bridge
  round-trip + audit + concurrency + `client_360` shape/denial, CRM validation paths, stale-digest
  idempotency (with a self-caught fix protecting against deleting a real same-day production digest
  — see thread notes), hybrid FTS-arm ranking + filters + `recall_memory` untouched proof,
  fetch-scope, vitals no-leak checks. NOT yet run live — migration 0027 is unapplied, so its
  RPC/column-level checks would correctly fail right now; this is expected per the script's own
  precondition header.
- `scripts/smoke-hosted-mcp.mjs` extended with a new "THREAD 0032 ADDITIONS" section proving the
  same bridge/hybrid/fetch-scope/brief surface through the live hosted MCP tool dispatch: recall
  still succeeds post-hybrid-switch, an invalid `kind` filter is rejected as a tool error (not
  silently ignored), an unmatched `heading` on `fetch` returns a structured tool error, and
  `brief("intellioptics-2-5")` resolves via `projects_fk` (the exec-pro repro this unit's
  name-normalization fix exists to close) when the DB's "IntelliOptics 2.5" project row is present.
- `functions/api/recall.ts` (the dashboard's `/api/recall` search endpoint, unrelated to the MCP
  `recall` tool) was deliberately left unchanged — its own `MAX_K=50` cap is a different surface
  than the "hosted keeps k≤20 cap" language in the design, which refers to the MCP tools.

**Not run / cannot verify from this environment:** the migration itself has not been applied, so no
live RPC/EXPLAIN/cron-count checks have executed yet; the UI riders are visually unverified (no
browser session available this session) — screenshot/video for Aegis is still outstanding.

**Next steps (in order):** Aegis post-build code QC → Jesse apply-go → apply migration 0027 → run
`scripts/smoke-bridge-crm-hybrid.mjs` and the extended `scripts/smoke-hosted-mcp.mjs` live → confirm
old `recall_memory(vector,int)` still serves deployed code → push the code (caller switch + all
above) → re-run both smoke batteries against the pushed deploy → Aegis live sign-off → capture UI
rider screenshot/video.

---

## Aegis Post-Build QC - 2026-07-02

**Verdict: NOT APPROVED for migration apply/push yet.** The implementation is close, and the main r2 design corrections are present, but one bridge write-path behavior can silently remove CRM linkage during normal memory re-ingestion.

### Blocking Finding

1. **`ingest_memory_entry` can wipe `client_id`/`deal_id` on conflict when the payload omits those optional fields.**
   - Evidence: `supabase/migrations/0027_bridge_crm_hybrid.sql` lines 56-57 derive omitted `client_id`/`deal_id` as NULL, and lines 119-122 assign `client_id = excluded.client_id, deal_id = excluded.deal_id` on conflict.
   - Impact: a canonical `memory/*.md` re-ingest that does not include bridge fields will set existing `memory_entries.client_id` / `deal_id` back to NULL. That breaks the bridge by silently unlinking memories from CRM clients/deals.
   - Why this matters: the accepted design calls these link fields optional. `update_memory` correctly preserves existing links when keys are absent and only clears on explicit key presence, as shown in lines 224-228. `ingest_memory_entry` should use the same omitted-versus-explicit-null semantics unless the team deliberately wants source-file re-ingest to be a full replacement for links.
   - Required fix: preserve existing link columns on conflict unless the incoming payload explicitly contains the key. Example behavior: `client_id = case when payload ? 'client_id' then excluded.client_id else public.memory_entries.client_id end`, same for `deal_id`. Add smoke coverage for both cases: omitted preserves; explicit null clears.

### Non-Blocking Notes

- The migration correctly creates a new `recall_memory_hybrid(...)` and does not replace/overload the old `recall_memory(vector,int)`. This satisfies the r2 deploy-window requirement.
- `client_360` is service-role-only in SQL and the hosted endpoint gates through `requireMember()` before calling it. This satisfies the r2 auth posture requirement.
- The local recall fallback is correctly limited to missing-function errors. Because hosted MCP imports the same core, the fallback also exists hosted-side; if code were pushed before migration apply, new recall filters could be ignored by the fallback to old `recall_memory`. This is acceptable only if the documented apply-before-push gate is followed. A stricter fix would disable fallback when `client_id`, `deal_id`, `project_id`, or `kind` is present.
- `log_activity`'s null-actor carve-out is exact-action scoped to `crm.stale_deals`; prior service-role-only execute grants remain the exposure boundary.
- Live smoke remains pending because migration 0027 is intentionally unapplied. UI rider screenshot/video remains pending and should not be treated as visually accepted yet.

### Verification Run

- `npm run build` - PASS
- `node mcp/test-recall.mjs` - PASS, 39/39
- `node mcp/test-fetch.mjs` - PASS, 75/75
- Remaining keyless MCP tests - PASS: getsecret 17/17, log 34/34, remember 60/60, update 42/42, usage 5/5
- `node --check` on changed MJS scripts/core files - PASS

### Gate

Atlas/Sonnet should fix the `ingest_memory_entry` link-preservation behavior before Jesse applies migration 0027 or before the code is pushed/deployed. After the fix, rerun build, keyless MCP tests, `node --check`, then run the live bridge/hybrid smoke only after migration apply.

### Fable response — fix-round decisions (2026-07-02) → SONNET EXECUTES

Blocker accepted without pushback — re-ingest silently unlinking the bridge is exactly the class of
slow-rot defect this QC exists to catch. Decisions so nothing is guessed:

1. **Blocker fix (edit the UNAPPLIED `0027_bridge_crm_hybrid.sql` directly — 0026/0027 precedent):**
   implement Aegis's omitted-vs-explicit-null semantics verbatim. The payload must distinguish
   "key absent" (preserve existing link) from "key present with null" (explicit unlink). Aegis's
   example is the spec: `client_id = case when <payload has key 'client_id'> then
   excluded.client_id else public.memory_entries.client_id end`, same for `deal_id`. Mirror
   whatever key-presence mechanism `update_memory` already uses (lines ~224-228) so the two RPCs
   share one convention — do not invent a second one.
2. **Smoke coverage (required by the QC, both directions):** in `smoke-bridge-crm-hybrid.mjs` —
   (a) ingest w/ link → re-ingest same entry WITHOUT bridge keys → link PRESERVED;
   (b) re-ingest WITH explicit `client_id: null` → link CLEARED (and, since it flows through the
   same conflict path, assert `updated_at` bumped both times).
3. **Non-blocking fallback note — ADOPT THE STRICTER FIX (decided):** in the shared recall core,
   when any filter (`kind`/`project_id`/`client_id`/`deal_id`) is present, the missing-function
   fallback to old `recall_memory` is DISABLED — return a structured error ("hybrid recall not yet
   available; retry unfiltered or wait for migration") instead of silently returning unfiltered
   results as if filtered. Rationale: the local stdio MCP runs from the working tree, so new core
   code can meet an un-migrated DB *today* regardless of deploy discipline — silent filter-dropping
   is a correctness lie to agents; unfiltered queries keep working via fallback. Add a keyless test
   case for the filtered-fallback error path.
4. Everything else stands as Aegis noted: live smoke + UI screenshot/video happen post-apply; the
   apply-before-push order is unchanged (fix → re-verify → Aegis re-QC → Jesse apply-go → apply →
   live smokes → push → Aegis live sign-off).

**Sonnet close-out per SOP:** rerun `npm run build` + all keyless `mcp/test-*.mjs` + `node --check`
on changed files; commit locally w/ explicit paths (NO push — migration still unapplied); brain-log;
update this doc's status line; stop for Aegis re-QC.

---

## Sonnet 5 Fix-Round Report — 2026-07-02

All 3 fix-round decisions executed against the UNAPPLIED migration:

1. **Blocker fix.** `supabase/migrations/0027_bridge_crm_hybrid.sql`, `ingest_memory_entry`'s
   `on conflict (name) do update set` clause now uses Aegis's exact omitted-vs-explicit-null
   semantics, mirroring `update_memory`: `client_id = case when payload ? 'client_id' then
   excluded.client_id else public.memory_entries.client_id end` (same pattern for `deal_id`). A
   re-ingest that omits bridge keys preserves the existing link; a re-ingest with an explicit
   `client_id: null`/`deal_id: null` clears it. Documented inline at the ON CONFLICT clause and in
   the migration's header decision-log.
2. **Smoke coverage, both directions.** `scripts/smoke-bridge-crm-hybrid.mjs` §2 (Bridge) now covers,
   against the live fixture entry: (a) re-ingest omitting both keys → both links preserved + `updated_at`
   bumped; (b) re-ingest with explicit `client_id: null` (deal_id key still absent) → `client_id`
   cleared, `deal_id` preserved + `updated_at` bumped again; then restores both links for the
   downstream `client_360`/hybrid-filter checks later in the script. Not yet run live — same
   precondition as before (migration unapplied).
3. **Stricter fallback, adopted.** `mcp/lib/recall-core.mjs`'s `runRecall` now refuses to silently
   fall back to the old `recall_memory` when ANY filter (`kind`/`project_id`/`client_id`/`deal_id`) is
   present and the hybrid function is missing — it throws a structured error naming the cause instead
   of returning unfiltered results as if they were filtered. Genuinely unfiltered queries still fall
   back exactly as before. `mcp/test-recall.mjs` gained 4 new cases proving: filtered+missing-function
   rejects (kind and client_id variants), the error message names the real cause, and the unfiltered
   fallback path still works unchanged (43/43 recall tests passing, up from 39).

**Verification (2026-07-02, fix round):**
- `npm run build` — green.
- All `mcp/test-*.mjs` green: fetch 75/75, getsecret 17/17, log 34/34, recall 43/43 (+4 new), remember
  60/60, update 42/42, usage 5/5 — 276/276 total, no regressions.
- `node --check` clean on the 3 changed files (migration is SQL, not checked this way; syntax
  reviewed by hand against the existing `update_memory` pattern it mirrors).

**Not run / cannot verify from this environment:** live DB checks (migration still unapplied) —
the new smoke assertions in §2 will execute for the first time post-apply, same as the rest of the
battery.

**Next steps (unchanged from before the fix round):** Aegis re-QC → Jesse apply-go → apply migration
0027 → run both smoke batteries live → confirm old `recall_memory(vector,int)` still serves deployed
code → push → re-run both smoke batteries against the pushed deploy → Aegis live sign-off → capture UI
rider screenshot/video.

---

## Aegis Fix-Round Re-Check - 2026-07-02

**Verdict: APPROVED to proceed to the migration-apply/live-smoke gate.** This is not final live sign-off yet; it means the prior post-build blocker has been corrected and the local/keyless verification gates are clean.

### Prior Blocking Finding - Resolved

1. **`ingest_memory_entry` link preservation is fixed.**
   - Evidence: `supabase/migrations/0027_bridge_crm_hybrid.sql` now preserves existing `memory_entries.client_id` / `deal_id` on conflict when the incoming payload omits those keys, and only applies `excluded.client_id` / `excluded.deal_id` when the corresponding key is explicitly present.
   - This now matches `update_memory`'s omitted-versus-explicit-null semantics: omitted preserves; explicit null clears.
   - `scripts/smoke-bridge-crm-hybrid.mjs` now includes live smoke coverage for both directions: omitted bridge keys preserve links, and explicit null clears only the named link.

### Fallback Note - Resolved Above Requirement

- The prior non-blocking fallback concern was adopted as a stricter fix. `mcp/lib/recall-core.mjs` now refuses to fall back to old `recall_memory` when any filter (`kind`, `project_id`, `client_id`, `deal_id`) is present and `recall_memory_hybrid` is missing. Unfiltered queries still keep the pre-migration safety fallback.
- `mcp/test-recall.mjs` now covers the filtered-missing-function error path and the unchanged unfiltered fallback path.

### Verification Run

- `npm run build` - PASS
- `node mcp/test-recall.mjs` - PASS, 43/43
- `node mcp/test-fetch.mjs` - PASS, 75/75
- Remaining keyless MCP tests - PASS: getsecret 17/17, log 34/34, remember 60/60, update 42/42, usage 5/5
- `node --check` on changed MJS scripts/core files - PASS

### Gate

Aegis approves moving to the next controlled step: apply migration 0027, run `scripts/smoke-bridge-crm-hybrid.mjs`, run the extended hosted MCP smoke, confirm old `recall_memory(vector,int)` still works during the deploy window, then push/deploy and repeat live smoke. UI rider screenshot/video remains required before final visual acceptance.

---

## GATE EXECUTED — 2026-07-03 (Fable, on Aegis fix-round approval + Jesse-forwarded gate order)

1. **Migration `0027` APPLIED** (sanctioned MCP channel). Post-apply gate proven by SQL: all new
   columns/FKs/checks on memory_entries/documents/clients/contacts/deals; exactly ONE
   `mnemosyne_stale_deals_daily` cron job; `client_360`/`recall_memory_hybrid`/digest fn
   service-role-only; FTS GIN index present; **old `recall_memory(vector,int)` untouched and
   verified working throughout the deploy window** (smoke check + direct proof).
2. **Two REAL bugs found live and fixed as follow-up migrations (both applied + repo files match):**
   - `0028_recall_hybrid_ambiguity_fix` — 42702: RETURNS TABLE OUT variables captured the CTE column
     references (`distinct on (name)`); fixed with `#variable_conflict use_column`. Keyless tests
     structurally cannot catch this class (no live DB) — noted for the QC playbook.
   - `0029_recall_hybrid_similarity_cast` — 42804 masked behind the 42702: the RRF+boost expression
     is numeric math, mismatching the declared double precision; cast added.
3. **Smoke fixes (same commit):** canonical fixture link-updates now pass `change_reason` (the RPC
   rule is correct; the smoke was wrong); the `cron.job` Data-API check reframed — PostgREST cannot
   see the cron schema (verified), job existence is the post-apply SQL gate's proof.
4. **Third real bug, post-deploy:** `slugify` STRIPPED punctuation instead of hyphenating
   ("IntelliOptics 2.5" → `intellioptics-25` ≠ `intellioptics-2-5`), so the FK slug arm could never
   hit the exec-pro repro it was built for. Fixed (`21c5719`) to the ingest RPC's convention
   (`[^a-z0-9]+` → '-'). The repro check caught it exactly as designed.
5. **Deploy order followed:** apply → old-recall proof → push (`022aa92`, `21c5719`) → CF deploy.
   Note for the ops playbook: production-alias edge propagation lagged the Active deployment TWICE
   (~1-2 min) — new-endpoint 405s and a stale brief bundle; the deployment-specific preview URL
   (`SMOKE_BASE=https://<id>.project-mnemosyne.pages.dev`) is the propagation-proof verification
   target; re-verify the alias after.
6. **Final live record:** bridge/CRM/hybrid **68/68** · hosted MCP **65/65** (incl. exec-pro repro
   via `projects_fk`) · render **19/19** · telemetry **14/14** · log-update **15/15**.

**Remaining for final close:** UI-rider visual acceptance (screenshot/video of the animated node
cloud + bridge edges + vitals strip — needs a human browser session) → Aegis live sign-off over this
record.

### UI-rider visual acceptance — 2026-07-03 (Jesse, in-browser)

Two rounds of fixes from Jesse's screenshots (`docs/header.png`, `docs/current.png`):
`51027c6` (vitals to own rail — inline placement wrapped name/signout/stat labels at max-w-5xl;
bounded graph physics — cooldownTime Infinity spread nodes past the one-time zoomToFit) and
`719f7c4` (weak center gravity — unlinked singletons repelled to frame edges inflated the fit
bounding box, rendering the connected core tiny). **Jesse accepted the result in-browser
("that looks fine for now").** Rider status: ACCEPTED for this unit; further polish belongs to the
deferred Mission-Control unit. **0032 now awaits ONLY Aegis live sign-off over the full gate
record above.**
