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
- **S1 CLOSED AS ALREADY-SATISFIED — design-doc error, Jesse caught it (2026-07-10).** The
  rotation happened 2026-07-02 in the 0027 deploy gate: new `sb_secret` piped direct to CF +
  `.env.local`/`mcp/.env.local` patched + **legacy JWT keys disabled project-wide** — the key the
  killed REMOTE-SETUP runbook had exposed died then. Re-verified live today: both env files hold
  `sb_secret`-format keys (boolean check only, no material echoed) and the Management API returns
  `{"enabled":false}` for legacy API keys. Root cause of the false reopen: the architecture review
  agent read the 0024 roadmap (written 7/1, PRE-rotation) + the historical gate comment in
  `mcp.ts:14-16` and reported rotation "still owed"; Atlas carried it into this design + the Unit S
  WO without cross-checking the 7/2 record. Lesson recorded: review-agent findings about
  *completed-vs-owed state* must be checked against the thread docs' close-out entries, not just
  roadmap docs and code comments (both age). The stale `mcp.ts` gate comment should be updated to
  past-tense in the next code-touching unit (cosmetic, not urgent).

**✅ UNIT S FINAL SIGN-OFF — 2026-07-10 (Atlas/Fable QC, Jesse gate-close on S1).** All acceptance
criteria met: SQL-layer tenant backstop live + proven both directions + `42501` denials proven;
honest `score`/`similarity` live with ordering unchanged; key posture verified rotated/legacy-dead.
**Next: Unit L (Librarian v1, migration `0034`) — Atlas writes the WO on request.**

---

## Unit L — Aegis Build Report — 2026-07-10

**STATUS: BUILT LOCALLY, MIGRATION HELD UNAPPLIED, AWAITING ATLAS/FABLE QC + JESSE APPLY-GO.**

Implemented the Unit L work order in the working tree while preserving Atlas's in-progress changes:

- `supabase/migrations/0034_librarian_v1.sql`: lifecycle columns, side-table recall stats, archived
  filtering, curation RPCs, volatile recall bumps, report-only librarian digest + cron, and the
  service-role-only version reader. The side-table preserves the `updated_at` concurrency contract.
- Revert core and local/hosted `revert` tools, including egress secret refusal before embedding,
  shared update payload construction, optimistic concurrency, and append-only versioning.
- Archived filters in the brief and Memories browse query.
- `docs/runbooks/librarian.md`: human-gated consolidation/stale/dead-link procedure and L6 weekly
  activity synthesis section.
- `scripts/smoke-librarian.mjs`: post-apply digest, four-section, fixture, cleanup, and same-day
  idempotency smoke. Extended `scripts/smoke-bridge-crm-hybrid.mjs` with recall-stat, archived
  exclusion, and unchanged-`updated_at` regression assertions.
- Carried S1 stale rotation comment to past tense.

### Verification

- `node mcp/test-revert.mjs` — PASS, 23/23.
- `node --check scripts/smoke-librarian.mjs` and `node --check mcp/lib/revert-core.mjs` — PASS.
- `npm run build` — PASS, TypeScript/functions/Vite production build.
- `git diff --check` — PASS.
- Full live SQL dry-run, post-apply ACL/provolatile/cron gate, live smokes, and operator-MCP commit
  logging are not run in this build phase. The Supabase CLI is unavailable in this environment;
  migration execution remains explicitly gated and no machine token was minted.

### QC Targets / Known Review Points

- Atlas/Fable must transactionally dry-run `0034` against the hosted database and verify all new and
  replaced function ACLs, volatility, cron registration, and unchanged `updated_at` histogram.
- Confirm `log_activity`'s narrowly extended null-actor carve-out for `librarian.digest` is accepted.
- Confirm the `archive_memory` defaulted trailing reason parameter shape and report JSON string fields
  satisfy the existing flat-detail audit contract.
- After apply-go, run `scripts/smoke-librarian.mjs`, the extended bridge smoke, and the revert round-trip
  smoke before any code/migration push.

---

## Unit L QC Record — Aegis — 2026-07-27

### Verdict

**HOLD on final Unit L acceptance at reviewed HEAD `ad249ef`.** This verdict covers the shipped Unit L
implementation in `54a83b0`, the provisioning correction in `c6d9944`, and the smoke fixes in
`76ae79e`. Function security, recall-side-table behavior, same-day librarian execution, tool/scope/rate
parity, and hosted revert all pass independent checks. The hold is for one production lifecycle defect:
`verified_at` is nullable with no default, and three post-apply MCP-created memories already have
`verified_at IS NULL`; SQL three-valued logic excludes them forever from both stale predicates. The
first real digest acceptance demo with Jesse also remains outstanding and is not marked complete here.

### Independent verification run

- `node mcp/test-revert.mjs` — **23/23 PASS**.
- `npm run build` — **PASS** (`tsc -b`, functions typecheck, Vite production build).
- `git diff --check` — **PASS** before this record was appended.
- `node --env-file=.env.local scripts/smoke-librarian.mjs` — **12/12 PASS twice consecutively** on
  2026-07-27. Both runs reported `dead_links_count=30` with a nine-item capped sample and cleaned up.
- `node --env-file=.env.local scripts/smoke-bridge-crm-hybrid.mjs` — **78/78 PASS**, including a
  two-call recall-count increment, unchanged `memory_entries.updated_at`, archive exclusion, unarchive,
  and anon/authenticated execute denials.
- A one-off raw hosted-MCP round trip ran
  `remember → fetch → update → revert(version 1) → fetch`; it restored title, body, and kind, produced
  the append-only version chain `[1,2]`, and recorded
  `change_reason='revert to v1: hosted transport QC'`. Exact-name fixture, version, and audit cleanup
  completed; a final query found zero `smoke-0034-*`/`smoke-0032-*` memory rows.
- A read-only Supabase Management API catalog query joined `pg_proc`/`pg_namespace`, inspected
  `pg_class`, `information_schema.columns`, and `cron.job`, and a raw hosted `tools/list` returned all
  ten tools, including `revert`. No token or secret value was printed.

### Per-target findings

1. **VERIFIED — function ACLs, volatility, and cron.** The live catalog query returned exactly the
   eight targeted functions with `prosecdef=true`, `proconfig={"search_path=\"\""}`, and
   `proacl={postgres=X/postgres,service_role=X/postgres}` — no PUBLIC/anon/authenticated execute.
   `archive_memory`, `confirm_memory_verified`, `get_agent_client_context`,
   `recall_memory_hybrid`, `log_activity`, and `run_memory_librarian` are volatile; `client_360` and
   `get_memory_version` are stable. `cron.job` returned one active
   `mnemosyne_memory_librarian_daily` row at `10 12 * * *` with
   `select public.run_memory_librarian();`. `memory_recall_stats` has RLS enabled; authenticated has
   SELECT only, while service-role writes remain available through its bypass/definer paths.

2. **VERIFIED — null-actor carve-out remains exact.** The live function-body probe for the five-arg
   `log_activity` signature returned true only for
   `p_action not in ('crm.stale_deals', 'librarian.digest')`; the active-member branch remains the
   only alternative (`0034_librarian_v1.sql:344-384`). The same live function is service-role-only,
   so no client role can select the privileged action string to widen the path.

3. **VERIFIED — `archive_memory` signature and flat audit detail.** Live identity arguments are
   `(uuid,text,boolean,uuid,text)`. The migration defaults both trailing parameters, then rejects a
   null/blank reason at runtime (`0034:36-66`), which is the valid PostgreSQL shape. Its audit object
   contains only scalar `name`, `reason`, and string-or-null `superseded_by` values (`0034:87-97`),
   satisfying `log_activity`'s flat-detail contract. The 78-check live smoke exercised archive and
   unarchive successfully.

4. **VERIFIED — recall does not mutate entry freshness.** The 78-check live smoke read the entry
   timestamp, called `recall_memory_hybrid` twice, observed `recall_count` rise from 4 to 6 with a
   fresh `last_recalled_at`, and observed byte-identical `memory_entries.updated_at`
   (`smoke-bridge-crm-hybrid.mjs:353-362`). The migration writes only
   `memory_recall_stats` in both recall RPCs (`0034:218-229`, `323-333`).

5. **VERIFIED — hosted tool/scope/rate parity after the `c6d9944` fix.** A local parser compared all
   ten `TOOLS` names/scopes in `functions/api/mcp.ts`, all ten `RATE_LIMITS` keys, and all ten
   `ALL_SCOPES` entries in `scripts/provision-machine.mjs`; the four differences
   (`missing_rate_bucket`, `orphan_rate_bucket`, `ungrantable_tool_scope`,
   `orphan_grantable_scope`) were all empty. Raw live `tools/list` returned the same ten names and
   included `revert`. The bucket dereference at `mcp.ts:409-410` is therefore defined for every tool.

6. **VERIFIED — same-day smoke repeatability fix.** Two consecutive production runs on the same UTC
   date each passed 12/12. Cleanup now targets `detail->>digest_date` using a UTC-derived date
   (`smoke-librarian.mjs:20-34`), matching PostgreSQL `current_date`; neither run read the prior run's
   digest. Final fixture query returned zero.

7. **DEFECT — dead-link fix is sound, but sibling section coverage is not.** The new baseline-count
   assertion passed twice (`expected 30, got 30`) while the capped sample held nine items, proving the
   dead-link test no longer trusts the sample (`smoke-librarian.mjs:37-45,67-74`). The sibling audit
   found:
   - `near_dups_json` is checked only for string type; neither `near_dups_count` nor the seeded
     `dupA`/`dupB` pair is asserted (`lines 56,65`). A synthetic digest with
     `near_dups_count=999` and `near_dups_json='[]'` passes every current near-dup check.
   - stale and consolidation still search capped samples (`lines 66,75`). Synthetic 16-result
     digests whose first 15 items omit the fixture have honest counts that include it, while both
     current fixture assertions fail. These are test false-positive/false-negative defects, not
     evidence of incorrect production counts.

8. **VERIFIED — hosted revert coverage hole closed during this QC.** The raw hosted round trip
   exercised the deployed `revert` tool, not the local core alone. The post-revert fetch restored the
   prior title/body/kind; catalog inspection showed two immutable snapshots; the latest
   `memory.update` audit reason was canonical; cleanup passed. Local secret-refusal and
   before-embed/no-update behavior independently remains covered by `mcp/test-revert.mjs` 23/23
   (`test-revert.mjs:60-69`).

9. **DEFECT (known design wart; no Unit L code change) — digest sample truncation is silent.** Live
   evidence again showed `dead_links_count=30` with a nine-item sample. Counts remain authoritative,
   but consumers cannot distinguish a complete sample from a capped one without comparing parsed
   array length to the count themselves.

### New defects and reproductions

1. **Production lifecycle defect — new memories can evade the stale queue forever.**
   - Live reproduction:
     `information_schema.columns` reports `verified_at nullable=YES, default=NULL`; then
     `select count(*), min(created_at), max(created_at) from memory_entries where verified_at is null`
     returned **3**, all `source_path` class `mcp`, created from
     `2026-07-26T22:10:47Z` through `2026-07-27T00:38:52Z` after migration apply.
   - Static cause: `0034:10-18` adds a nullable/no-default column and backfills only rows existing at
     apply time. Current creation paths omit the column, including `remember_memory`
     (`0009_mcp_write_subsystem.sql:125-130`), `ingest_memory_entry`
     (`0027_bridge_crm_hybrid.sql:118-125`), `upsert_client_brief` (`0030:99-100`), and
     `record_agent_outcome` (`0031:176-180`).
   - Impact/reproduction query: both stale arms use `e.verified_at < ...` (`0034:412-429`), which is
     UNKNOWN for NULL and therefore excludes the row. These entries will never age into the digest.
   - Required forward fix: in the next migration, backfill NULLs from `updated_at` with
     `trg_memory_entries_updated_at` disabled as in `0034`, then set `verified_at DEFAULT now()` and
     `NOT NULL`. If NULL is instead meant to encode “never verified,” the librarian must explicitly
     queue NULL as unverified; the current half-state is not acceptable.

2. **Librarian-smoke sibling coverage defects.**
   - Reproduction command evaluated the exact current predicates against synthetic capped digests:
     near-dups passed all current checks with count 999 and no fixture pair; stale and consolidation
     counts included a 16th fixture while their sample-search checks returned false.
   - Required test fix: capture pre-insert baselines for all four counts; assert the expected deltas;
     parse each sample only for shape/cap honesty. For near-dups, account for the exact number of new
     pairs produced by two identical fixtures rather than assuming a single pair.

### Recommendation for silent truncation

Claim the first free migration after Unit R's `0035` (prefer
`0036_librarian_qc_fixes.sql`, subject to Atlas/Jesse's sequencing call) and replace
`run_memory_librarian()` with four flat boolean fields:
`stale_truncated`, `near_dups_truncated`, `dead_links_truncated`, and
`consolidation_truncated`. Compute each after the trim loops as
`reported_count > jsonb_array_length(reported_sample)`. This covers both SQL row limits and the
950-character trimming pass, stays inside the existing flat-detail contract, and matches the honest
truncation behavior already used by `brief` and `client_360`. The same migration is the natural place
for the `verified_at` default/backfill/not-null repair above.

**AEGIS SIGN-OFF — reviewed HEAD `ad249ef` (`main`); verdict HOLD pending the `verified_at` lifecycle
forward fix and corrected sibling smoke assertions. No push performed.**
