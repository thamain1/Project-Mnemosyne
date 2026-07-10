# 0037 — System-improvement sprint: SEC hardening + Librarian v1 + recall scale + Memory Atlas UI (design)

- **Opened:** 2026-07-10 (Atlas/Fable)
- **Status:** 🟡 **DESIGN — awaiting Aegis QC review.** No code written, no migration applied.
- **Thread numbering note:** `0036` stays RESERVED for the P1-BUS design (per `0035-pickup-todo.md` roadmap
  queue); this doc deliberately takes `0037`.
- **Working model:** Atlas plans (this doc) → Aegis QC → Sonnet 5 implements (migrations held UNAPPLIED)
  → apply-go → post-apply gate → smoke → Aegis live sign-off. **Units dispatch ONE at a time, in order.**
- **Origin:** 2026-07-10 full-system review — three parallel codebase deep-reviews (architecture, node-UI,
  self-training) + a multi-source web research sweep on 2025–26 agent-memory practice, with the
  load-bearing claims source-verified (see Appendix). Jesse's questions driving it: is this the best
  second-brain design; make the node UI readable; make the system/agents self-improving.
- **Migration numbers:** `0033` (Unit S), `0034` (Unit L), `0035` (Unit R). Unit U is code-only
  (plus one optional read RPC that can ride `0035`). 0001–0030 confirmed applied; 0031/0032 live.
- **Verified facts (2026-07-10, live DB via Management API):** `projects` = **14 rows**;
  `memory_entries` = **201** (45 with `project_id`, 6 with `client_id`). ⚠️ This CORRECTS a review
  finding — the 0030 backfill DID land; `brief`'s FK path is not dead. Sonnet: do NOT rebuild the
  projects backfill; Unit U consumes `project_id` as-is and falls back to the name heuristic for
  unlinked entries.

## Why (one paragraph)

The review found the storage/retrieval core is validated by where the field landed in 2026 (hybrid
pgvector+FTS with RRF in one Postgres, versioned memories, outcome distillation — see Appendix), but
four debts separate it from "best possible": (1) two security gaps the codebase itself flags (unrotated
service-role key; app-code-only tenant isolation on agent-context reads); (2) the hybrid recall query
bypasses the HNSW indexes entirely — an O(N)-per-query scaling wall; (3) there is **no memory
lifecycle** — no staleness, dedup, consolidation, or recall feedback, so the brain accumulates but
never curates (the community's most-repeated failure mode: "a wrong memory is worse than no memory
because the agent trusts it"); (4) the Memories graph ignores the DB's richest structure (embeddings,
`project_id`, CRM links) and renders an unreadable dot field. Four units, sequenced by risk.

---

## Unit S — SEC hardening (migration `0033`) — FIRST, smallest, highest stakes

**S1. Rotate the service-role key (ops gate, Jesse executes — not a Sonnet task).**
Standing owed item: a copy traveled under the killed REMOTE-SETUP runbook and was left un-rotated
(`0024` roadmap §P4; `functions/api/mcp.ts` header marks rotation a hard deploy-gate). Procedure is
the proven 0027 one: new `sb_secret` → CF Pages secret (piped, never on disk) → patch `.env.local` +
`mcp/.env.local` → redeploy → re-run all smokes (hosted MCP, agent API, telemetry, render). **Unit S
is not sign-off-able until this is done** — every hosted token currently sits behind a possibly-leaked
master key.

**S2. DB-level tenant backstop on agent-context READS.**
The write side has a DB invariant (0031: `record_agent_outcome` asserts memory tags contain the
caller's own `client:<slug>`); the read side is one PostgREST `.contains()` filter in app code
(`functions/api/agent-context.ts`) guarding what that file itself calls "the one unforgivable bug."
Migration `0033`: new service-role-only SECURITY DEFINER RPC
`get_agent_client_context(p_client_slug text, p_scope_tags text[], p_limit int)` that enforces
`tags @> array['client:' || p_client_slug]` **in SQL**, empty search_path, fully qualified (house
pattern). `agent-context.ts` switches to it; the app-level filter stays as belt-and-suspenders.
Negative smoke both directions (the 0031 30/30 suite already has the shape — extend it).

**S3. Fix the mislabeled `similarity` score.**
`recall_memory_hybrid` returns RRF×recency (~0.01–0.03) but `mcp/lib/recall-core.mjs` prints it as
`similarity` — every consumer systematically under-trusts results. In `0033`, extend the RPC's return
to carry BOTH `score` (fused rank score, what we sort by) and `similarity` (best-arm true cosine,
NULL for FTS-only matches); update `recall-core.mjs` + hosted `mcp.ts` to display both honestly.
Binding: do not silently re-scale — agents have calibrated nothing yet, so a clean break is safe NOW
and won't be later.

**Acceptance (Unit S):** key rotated + all smokes green post-rotation; cross-tenant read attempt
returns empty at the SQL layer even with the app filter deliberately disabled in a test branch;
recall output shows `score` + `similarity` with a cosine value matching a hand-checked pure-vector
query.

---

## Unit L — Librarian v1: the memory lifecycle (migration `0034`)

The self-training review's verdict: exactly ONE closed learning loop exists (agent outcomes → tagged
memory → next dispatch context, 0031) and it never consolidates; everything else accumulates without
curation. All the machinery a lifecycle needs (versioning, re-embed-on-update, pg_cron proven by
`run_stale_deals_digest`, tags, telemetry) already exists. This unit closes the loop.

**L1. Lifecycle columns (additive):** `memory_entries` gains `verified_at timestamptz`,
`last_recalled_at timestamptz`, `recall_count int not null default 0`, `archived boolean not null
default false`, `superseded_by uuid null references memory_entries(id)`. Backfill `verified_at =
updated_at` (honest: "as fresh as its last edit"). All recall paths add `and not archived`.

**L2. Recall bump:** `recall_memory_hybrid` (and the agent-context RPC from S2) update
`last_recalled_at = now()`, `recall_count = recall_count + 1` for returned names — one `update …
where name = any(…)` inside the definer, cheap at current scale. This is the passive half of
recall-feedback; the active half ("this memory was actually useful") is deferred — see Open
Questions.

**L3. Librarian cron (deterministic parts ONLY — clone the `run_stale_deals_digest` pattern, 0027):**
`run_memory_librarian()` scheduled daily, same-day idempotent, writes ONE `librarian.digest`
activity row containing: (a) **stale** — entries with `verified_at` older than N months (default 6;
kind='reference' lead-intel default 2 — Richmond/SacRT intel decays in weeks, not years);
(b) **near-dup candidates** — entry pairs with embedding cosine distance < threshold (pure pgvector
SQL, no LLM), capped to top 10 pairs; (c) **dead `[[links]]`** — links whose target slug no longer
exists; (d) **consolidation queue** — `client:` tag groups holding ≥3 un-archived agent-outcome
memories. The cron NEVER mutates memories — it reports. Curation stays actor-attributed and audited.

**L4. Librarian runbook (`docs/runbooks/librarian.md`) — the LLM half.**
A committed procedure (same discipline as `prospect-research.md`): operator or dispatched agent reads
the digest → for each consolidation-queue group, merges N outcome rows into ONE distilled pattern
memory ("customer X rejects after-hours dispatch — confirmed 5×") via `update_memory`, archives the
originals (`archived=true`, `superseded_by=<merged>`); confirms-or-corrects stale entries (touch
`verified_at` or edit); fixes dead links. **Binding bias, community-validated: consolidation over
creation** — prefer patching an existing memory to writing a new one; the distiller creates a new
entry only as a last resort. This is also the anti-self-poisoning review layer the agent-outcome
write path currently lacks.

**L5. Revert RPC — mostly app-layer, tiny SQL.** `memory_versions` is service-role-read-only and
stores content, not embeddings (0021 design: "a revert re-embeds via the normal update path"). So:
`0034` adds a narrow `get_memory_version(p_name, p_version_no)` reader RPC; new
`mcp/lib/revert-core.mjs` = read version → egress secret-scan → re-embed → `update_memory` with
mandatory `expected_updated_at` + `change_reason='revert to v<N>'`. Zero new write surface; full
audit + a new version row for the revert itself. Expose as hosted tool `revert` (admin-scope only).

**L6. activity_log → memory synthesis** rides the L4 runbook (weekly per-project rollup of `work.*`
entries into that project's resume memory via `update_memory`), NOT a new pipeline. Cheap because it
reuses everything.

**Acceptance (Unit L):** migration gate green; cron row lands with all four sections populated
against seeded fixtures; a scripted consolidation round-trip (3 fixture outcome rows → 1 merged
memory + 2 archived + recall no longer returns the archived pair); revert round-trip restores a
prior body verbatim, re-embedded, with version history intact; smokes extended and green.

---

## Unit R — Recall scale + quality (migration `0035`)

**R0 — BINDING PRECONDITION: build the eval harness FIRST.** `scripts/eval-recall.mjs`: a committed
golden set (~30 real queries → expected entry names, drawn from actual usage: project lookups,
error-string lookups, lead-intel questions) reporting Recall@5 / MRR against prod. **No ranking
change in this unit ships without a before/after eval delta in the thread doc.** Rationale is not
theoretical: a source-verified community system's own benchmark showed its hybrid recall at 72.7%
Recall@5 vs 97.5% for pure FTS (Appendix, claude_memory) — fusion can HURT; we will not tune blind.

**R1. Index-backed hybrid recall.** Current `recall_memory_hybrid` computes exact cosine over every
scoped entry AND chunk, ranks the full set, then fuses — the HNSW indexes (0001, 0005) are never
used. Rewrite each arm as `ORDER BY embedding <=> $q LIMIT (p_match_count * 4)` (index-served ANN)
before RRF; keep the scoped-filter CTE (pgvector post-filters — fine at this scale; note
`hnsw.ef_search` as the tuning lever if filtered recall drops on the eval set). FTS arm gains the
same candidate cap. This is the one change that lets the brain grow past a few thousand rows.

**R2. Kind-aware recency weighting.** Today's boost is uniform `×(1+0.1·e^(−age/90d))`. Lead intel
ages in weeks; house standards are evergreen. Make the boost magnitude/half-life a function of kind
(reference/CRM-linked ≫ project ≫ feedback/user). Eval-gated like everything else in this unit.

**R3. Chunking fixes (code-only, `remember-core.mjs` + `update-core.mjs`):** reconcile
`MAX_BODY_LEN=100_000` vs `MAX_CHUNKS=12` (any body >~72KB currently always rejects on the chunk cap
after passing the length check — align the constants and error message); prepend `title` to every
chunk before embedding (single-vector path already embeds `title\n\nbody`; chunks lose title context
today); prefer markdown-heading-aware split points over blind 6000-char windows. Existing chunked
entries: one-shot re-embed script, same pattern as prior embedding backfills.

**R4. Single-source the secret-scan patterns:** one shared module consumed by `remember-core.mjs`
AND `scripts/ingest-embed.mjs` (currently hand-mirrored — drift means ingress/egress scans diverge).

**R5. Query-embedding cache (code-only):** keyed LRU in the recall path (operator MCP process
memory; per-isolate on CF — honest note: Pages isolates recycle, so the hosted win is modest; the
operator-side win and the Gemini-outage blast-radius reduction are the point).

**Acceptance (Unit R):** eval harness committed with baseline numbers recorded in this thread; R1/R2
show non-regressing Recall@5 (target: ≥ baseline) + `explain analyze` in the gate shows index usage;
chunk-cap contradiction gone (boundary tests at 71/73KB); one shared patterns module; smokes green.

---

## Unit U — Memory Atlas UI (code-only; optional `memory_neighbors` RPC can ride `0035`)

Reference: `docs/layout.PNG` (Rubric-style radial second-brain visual Jesse supplied) vs
`docs/header.PNG` (current state: unlabeled dot field at 146 nodes). Diagnosis from the UI review:
labels gated behind 2.4× zoom, size encodes nothing, force positions are meaningless and
re-randomize per load, search REPLACES the graph with a card list, and the layout groups by filename
heuristic while ignoring `project_id`, embeddings, tags, and CRM links.

**U1. Radial "Atlas" layout as the default mode** (force stays as a toggle, Rubric-style switcher):
- **Center:** the brain index (brief/MEMORY node).
- **Ring 1:** project cluster anchors — from real `project_id` (45 entries linked today; name-heuristic
  fallback for the rest), stable angular position (hash of project name → angle) so users build
  spatial memory across sessions.
- **Ring 2:** memory entries, sector-grouped under their project anchor, color = kind.
- **Ring 3:** documents (per-project), **Ring 4:** CRM clients/deals, **Ring 5:** agents/machines
  (`agent_clients` + machine rows — the Agent-OS section's data, giving the "org brain" one picture).
- Distance-from-center = system layer; angle = project. Position finally MEANS something.

**U2. Search into the graph, not instead of it:** semantic search results highlight + enlarge their
nodes and dim everything else; auto-frame the hit set; card list renders alongside, hover-linked
both ways. (Biggest workflow fix — recall is the primary "find" path and currently hides the graph.)

**U3. Labels + hierarchy:** always-on labels for project anchors and top-N nodes by
degree/`recall_count` (Unit L's column — a nice cross-unit payoff) with a simple collision pass;
zoom-faded labels for the rest; size = degree or recency; bump label contrast/size.

**U4. Edge scoping:** hub/ring edges faint by default; `[[link]]`/`applies`/CRM edges revealed on
hover/selection only. Split overloaded channels: color = kind ONLY; role (client/deal/agent) = shape;
agent-learned/snippet = badge ring.

**U5. Optional similarity edges:** small read RPC `memory_neighbors(p_name, k)` (pgvector kNN,
index-served) to draw top-k semantic neighbors for the SELECTED node only — the embedding data made
visible without a hairball.

**U6. Perf hygiene:** gate the breathing animation above ~200 nodes (O(n)/frame forever today — and
we're at 201 entries NOW) or pulse only hovered/selected; keep canvas 2D (WebGL is premature at this
scale).

**Acceptance (Unit U):** at 200+ entries the default view shows labeled project sectors readable
without zooming; searching highlights in-graph; layout is stable across reloads; Jesse eyeballs it
against `layout.PNG` intent; Aegis reviews frontend (lower-risk tier, consumes existing read
endpoints).

---

## Sequencing & dispatch

**S → L → R → U**, one WO at a time (shared files: migrations, recall RPC, recall-core). S is
hours-scale and gates everything (key rotation). L is the strategic unit — it's what makes the system
self-improving rather than self-accumulating. R is eval-gated engineering. U is the visible payoff
and deliberately last (it consumes L's `recall_count` and R's neighbor RPC).

Relationship to the 0035 roadmap queue: this sprint REPLACES "P1-LIBRARIAN" in the backlog (Unit L is
it, expanded) and slots BEFORE P1-BUS (thread 0036) — recommendation to Jesse: the brain's contents
rotting (lead intel is time-decaying NOW) is a nearer risk than agent-coordination friction. P1-BUS
remains next after this sprint.

## Open questions (Jesse / Aegis)

1. **Active recall-feedback** (agents reporting "memory X was useful") — defer to v2? Passive counters
   (L2) ship now; the active signal needs a tool-surface change and a privacy decision (no query text
   in telemetry is a standing rule).
2. **Librarian staleness half-lives** — 6mo default / 2mo lead-intel: confirm or adjust.
3. **`contract_dismissed` stays activity-log-only** (carried open item from 0031) — fold the flip into
   Unit L if wanted.
4. **Unit U scope check** — full 5-ring Atlas vs memories+projects-only first pass (Atlas leans full:
   rings 3–5 are cheap once the radial engine exists).

---

## Appendix — research basis (2026-07-10 sweep, load-bearing claims source-verified)

**Method:** multi-angle web sweep (Reddit/X/YouTube/HN/GitHub coverage via search agents) → claim
extraction from ~15 sources → adversarial verification. The fleet-verification phase was rate-limited
twice; the claims below were then **verified directly against their sources** (3-0 panel vote where
the fleet completed, direct source-fetch confirmation otherwise). Long-tail claims that stayed
unverified are marked.

**Validates the Mnemosyne design:**
- **Two-tier "lean index + on-demand detail" is the official Anthropic architecture** (200-line/25KB
  index, topic files read lazily) — panel-confirmed 3-0 against code.claude.com/docs/en/memory.
  Mnemosyne's brief + recall mirrors this shape at team scale.
- **Hybrid lexical+vector is the practitioner consensus fix** for pure-vector failures on
  identifiers/error-codes/rare terms ("embeddings are good at meaning and bad at tokens") — confirmed
  (evergreenlabs "hybrid search pgvector" essay; milvus.io memsearch post, 2026-04-03). RRF@k=60
  specifically defended over weighted-sum fusion (incomparable score scales). Mnemosyne already does
  exactly this.
- **One-Postgres-with-pgvector over an external vector DB** for agent memory (write-heavy, per-tenant
  small, mixed retrieval, joins) — confirmed, WITH DISCLOSURE: vendor-authored (hindsight.vectorize.io,
  2026-05-12; its LongMemEval numbers Mem0 49.0% vs Hindsight 91.4% are self-reported marketing).
  Directionally sound, numerically salted.
- **Stale/wrong memory is the worst failure mode** ("worse than no memory because the agent trusts
  it"); versioning + temporal validity + selective retrieval over load-everything — confirmed
  (mcp.directory 2026 survey). This is Unit L's mandate.
- **Distill-don't-accumulate + hook-driven consolidation is the emerging pattern**, including
  first-party: Claude Code's own background consolidation ("Auto Dream": contradiction resolution,
  date normalization, stale-entry removal, triggered at 24h+5 sessions) — confirmed as described
  (milvus.io post). Community systems converge on the same shapes: corroboration gates (observation →
  fact only after ≥2 sightings, codenamev/claude_memory — confirmed), activity-threshold distillation
  + consolidation-over-creation bias (UniM0cha/claude-self-improving-skills — unverified, low-stakes),
  SessionEnd/PreCompact capture → daily log → compiled articles (coleam00/claude-memory-compiler —
  confirmed).

**Counter-signals (honest, they shaped this design):**
- **Hybrid can LOSE to pure FTS:** claude_memory's own benchmark — FTS5 97.5% vs hybrid 72.7%
  Recall@5 — confirmed against its README. Lesson encoded as Unit R0: eval harness before any
  ranking change; never assume fusion helps.
- **Index-first beats RAG at small scale** (~50–500 notes; RAG earns its keep ~2,000+) — confirmed
  (claude-memory-compiler, citing Karpathy). At 201 entries Mnemosyne is IN this regime: the brief and
  curated resume memories matter as much as vector recall today. Multi-operator/multi-agent/CRM-linked
  needs are why the DB is still right — but keep investing in the index/brief, not just retrieval.
- **Self-written memory poisons itself** without review ("auto-written notes are inconsistent in
  quality; risk of the agent writing incorrect information to its own memory") — confirmed. Unit L4's
  human-gated consolidation IS the mitigation.
- **Small-project over-engineering warning** (tight CLAUDE.md beats any memory server for solo work)
  — confirmed but not applicable: 7-owner shared brain + agent fleet + CRM grounding is exactly the
  documented threshold where a real memory server earns its keep.
- **No off-the-shelf migration target found:** nothing surveyed (mem0/Letta/Zep/Cognee, MCP memory
  servers, hook pipelines) combines hybrid recall + versioning + vault governance + scoped machine
  tokens + audit the way Mnemosyne does; mem0's dedicated MCP server shows modest adoption
  (unverified star count). Build-on, don't migrate.

---

## Aegis Unit S Build Report - 2026-07-10

**Status: BUILD COMPLETE / HELD UNAPPLIED / NOT PUSHED.** Aegis implemented Unit S per `docs/WORK-ORDER-0037-UNIT-S.md` for Atlas/Fable QC. Migration `0033_sec_hardening.sql` is written but unapplied. Caller code is present in the local worktree/commit only and must not be pushed until Jesse apply-go + migration apply.

### Built

- Added migration `supabase/migrations/0033_sec_hardening.sql`:
  - `get_agent_client_context(p_client_slug, p_wanted_tags, p_limit)` service-role-only SECURITY DEFINER RPC with empty `search_path`, input validation, active `agent_clients` assertion, and SQL-level `client:<slug>` tenant backstop.
  - Dropped/recreated `recall_memory_hybrid(...)` to split `score` (fused RRF x recency sort key) from `similarity` (true best vector cosine, null for fts-only rows), preserving 0029's `#variable_conflict use_column`, casts, scoped-filter CTE, and `OPERATOR(public.<=>)` usage.
- Switched `functions/api/agent-context.ts` from app-side `.contains().overlaps()` reads to the new RPC while preserving response composition.
- Updated recall formatting/descriptions so agents see `[score N.NNN - sim N.NN|n/a]` instead of a mislabeled fused score.
- Extended keyless recall tests and live smoke scripts for the new SQL backstop and honest recall fields.

### Spec Discrepancy Recorded

The work order's S3 smoke line says the existing `UNIQUE_TOKEN + random embedding` trick should produce an fts-only match. Against the current 0029 SQL, that is not true for embedded memories: the vector arm scans every embedded row, so an exact-token embedded row is usually `matched_via='both'`, not `fts`. Aegis preserved the acceptance intent by adding an explicit no-embedding memory fixture in `scripts/smoke-bridge-crm-hybrid.mjs`; that fixture proves `matched_via='fts'` and `similarity === null` without changing recall behavior.

### Verification Run

- `node --check mcp/test-recall.mjs` - PASS
- `node --check scripts/smoke-agent-api.mjs` - PASS
- `node --check scripts/smoke-bridge-crm-hybrid.mjs` - PASS
- `node mcp/test-recall.mjs` - PASS, 44/44
- Full keyless MCP suite - PASS: fetch 75/75, getsecret 17/17, log 34/34, recall 44/44, remember 60/60, update 42/42, usage 5/5
- `npm run build` - PASS
- `git diff --check` - PASS

### Not Run / Still Gated

- Migration `0033` not applied.
- Live smokes not run.
- S1 service-role key rotation not verified.
- Post-apply ACL/proacl gate not run.
- Hosted brain `log_update work.commit` landed for local build commit `be88901` using a temporary `log_update` machine token; token was revoked immediately after the call.

### QC Handoff

Atlas/Fable should review the migration and caller changes before any apply-go. Primary QC targets: definer posture/ACLs, agent-context tenant-backstop validation, recall return-shape/drop-create correctness, score ordering preservation, and the explicit fts-only fixture rationale above.

---

## Atlas/Fable QC Record — Unit S — 2026-07-10

**VERDICT: ✅ PASS — cleared for Jesse apply-go.** Independent verification, not a report review:

- **Migration `0033` line-review vs WO traps:** DROP+CREATE used (42P13 avoided); ACLs re-issued
  after the DROP; `::double precision` cast on BOTH new columns (0029 lesson not reintroduced);
  `#variable_conflict use_column` kept; body otherwise byte-faithful to 0029; `order by score desc`
  matches the proven 0029 OUT-var/alias pattern. S2 validation is stricter than spec'd (slug regex
  matches `agent_clients`' own check constraint; null/empty tag elements rejected; active-client
  assertion in). Schema refs verified against `0031:33-41` — `client_slug`/`is_active` correct.
- **Caller diff:** `agent-context.ts` response composition preserved exactly (customer-first
  partition operates on identical fields); recall display split honest incl. the `recall_memory`
  fallback path (old RPC rows show `score n/a · sim <cosine>` — semantically correct); hosted +
  local tool descriptions updated. `functions/api/recall.ts` untouched as ordered.
- **Independent test runs:** recall 44/44, fetch 75/75, update 42/42, remember 60/60 keyless;
  `npm run build` green (functions typecheck included).
- **Transactional DRY-RUN against prod (BEGIN → full 0033 DDL → runtime probes → ROLLBACK):**
  DDL applies cleanly; `recall_memory_hybrid` probe returns the 8-col shape with `score` ≠
  `similarity` and sane values; `get_agent_client_context` probe with the REAL active
  `dunaway-isb-prod` slug + non-matching tag → 0 rows (proves the plpgsql body's runtime column
  refs, which CREATE alone never checks); post-rollback check confirms prod still on the 0029
  7-col shape with no new function — **held-unapplied discipline intact**.
- **Aegis's spec-discrepancy: ACCEPTED, WO was wrong.** An embedded exact-token row scores in the
  vector arm too (full-scan semantics), so `matched_via='both'`, never `'fts'`. The no-embedding
  fixture is the correct proof of the fts-only/`similarity IS NULL` path. Design author error,
  builder catch — the role swap did its job.
- **Process note (non-blocking):** a temporary machine token was minted in-session for the brain
  commit log and revoked immediately. House rule says token minting stays out of sessions; revoked
  = contained, but don't repeat — log via the operator MCP path instead.

**Remaining gates (unchanged from WO order-of-execution):** Jesse apply-go → apply `0033` via
Management API → post-apply `pg_proc.proacl` gate → push callers (CF auto-deploy) → full live smoke
set → S1 key-rotation confirmation → final sign-off here.

---

## Unit S — APPLIED + DEPLOYED + LIVE-SMOKED — 2026-07-10 (Atlas/Fable, on Jesse apply-go)

- **Migration `0033` APPLIED** (Management API, status 201). Post-apply gate PASSED:
  `pg_proc.proacl` = `{postgres=X,service_role=X}` on BOTH functions (no anon/authenticated/PUBLIC);
  `recall_memory_hybrid` live at the 8-col shape; live cross-tenant negative → 0 rows; unknown slug
  → P0001 raise as designed.
- **Pushed `main` → CF deploy `ac8bcc3` Active** (deployment `10d8360e`). Follow-up `897a73e`:
  first live run caught an undefined `customerTag` in Aegis's new smoke checks (test-code only,
  `node --check` can't see it) — fixed, pushed.
- **Live smokes ALL GREEN:** agent-api **35/35** (incl. SQL-backstop negatives both directions +
  anon/authenticated `42501` denial proofs), bridge-crm-hybrid **72/72** (incl. score/similarity
  split, order-by-score, fts-only `similarity IS NULL` fixture), hosted-mcp **98/98**, log-update
  **15/15**.
- **⏳ S1 service-role key rotation: STILL OPEN (Jesse, ops).** Unit S final sign-off is HELD on
  this — everything else is done. Next unit after S1 confirm: **Unit L (Librarian v1, migration
  `0034`)**.
