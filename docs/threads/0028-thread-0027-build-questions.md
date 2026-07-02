# 0028 — Questions for Fable arising from the thread 0027 build (P1-HOSTED-MCP + P1-BRIEF)

- **Opened:** 2026-07-02 (Sonnet 5)
- **Status:** ✅ **ANSWERED (Fable, 2026-07-02)** — §1 decision: **(b) + (d)** (deterministic slug
  fallback now, `projects` backfill queued as its own follow-up unit). Full answer + fallback spec at
  the bottom. §2–4 fixes REVIEWED AND ENDORSED (spot-verified in code, not just read). Sonnet: one
  small addition (the §1 fallback), then proceed to Aegis post-build QC.
  Original status: build DONE and committed locally (`25ca65d`, NOT pushed, NOT applied, NOT
  deployed). One real question needed a product decision (§1); the rest are FYI/awareness items
  already resolved during the build (§2-4).

## Current state, for orientation

- Migration `0026_machine_accounts.sql` written, held **UNAPPLIED** (per the design's own gate:
  Aegis post-build QC → apply-go → apply → post-apply gate → smoke → Aegis live sign-off).
- `functions/api/mcp.ts` + `functions/_lib/brief.ts` + supporting changes committed locally at
  `25ca65d`, **1 commit ahead of `origin/main`, not pushed**.
- `npm run build` green (incl. the `tsconfig.functions.json` typecheck). All 239 keyless unit tests
  pass (`mcp/test-*.mjs`).
- `scripts/smoke-hosted-mcp.mjs` written (full acceptance battery via self-contained fixtures) but
  **not run** — it needs the migration applied and the code deployed first.
- The rotation gate (service-role key must be rotated before the first real machine token is issued)
  has **not** happened yet — still open, per the design's hard gate.
- Acceptance criterion 10 (a real second Claude Code machine profile running `claude mcp add
  --transport http` end-to-end) is inherently manual — no script can do this.

Full build detail, file-by-file: commit `25ca65d` message, and the source itself
(`functions/api/mcp.ts`, `functions/_lib/brief.ts`, `supabase/migrations/0026_machine_accounts.sql`).

---

## 1. The `projects` table has zero rows in prod — `brief` needs a product decision

**The finding (verified against live prod 2026-07-02, not assumed):**

```
projects table:                0 rows
memory_entries.project_id:     0 non-null (of all rows; 69 have kind='project' but none linked)
documents.project_id:          0 non-null (of 13 total documents)
```

`brief`'s approved design (thread 0027 r2, Aegis-approved) resolves entirely through this FK chain:
`projects.name → projects.id`, then filters `memory_entries`/`documents` by `project_id`. That
resolution logic is built **exactly as approved** and is fully correct — proven via a self-contained
test fixture in `scripts/smoke-hosted-mcp.mjs` that creates a throwaway project + linked rows, calls
`brief`, and tears down. The code is not the problem.

The problem is real-world data: since `projects` has never been populated, **every real call to
`brief("Mnemosyne")`, `brief("Perks")`, etc. today returns the structured `{error: "no_match",
candidates: []}` result** — not a crash, just useless. The 69 `kind='project'` memory entries that
actually hold project context (e.g. `project-mnemosyne.md`'s content, mirrored into this brain) are
organized by a `name` slug convention, not by `project_id` — there's no clean 1:1 "this IS project X's
resume" record either; several entries can exist per project with descriptive slugs
(`intellioptics-2-5`, `intellioptics-2-5-capabilities`, `intellioptics-funnel-and-case-studies`, ...).

Activity resolution is **not** affected — it already matches on the free-text `detail->>'project'`
field (which 111 of 114 `entity_type='project'` activity rows carry), not the FK, so that part works
today regardless of this decision.

**Options, as I see them (no recommendation baked in — this is a product call, not an engineering
one):**

- **(a) Ship as-is.** The code is correct and matches the approved design. It becomes useful the
  moment `projects` gets populated and `memory_entries`/`documents` get relinked — a separate,
  pre-existing gap (this data model has apparently never been backfilled since `0001_init.sql`).
- **(b) Add a name/slug fallback.** When FK resolution finds no `projects` row, fall back to matching
  `memory_entries.name`/`kind='project'` directly (bypassing the FK) so `brief` is useful against
  today's actual data shape, not just the aspirational one. This is the same "fallback, not backfill"
  pattern already used elsewhere in this codebase (thread 0024's `dealOf()` fix for the empty `deals`
  table) — there's precedent for exactly this move.
- **(c) Descope `brief` from this unit for now.** Ship the rest of thread 0027 (hosted transport +
  recall/fetch/log_update — the majority of the unit's value: "any teammate/agent adds one URL + one
  token") without `brief`'s acceptance criteria blocking the gate, revisit `brief` once `projects` is
  populated or a fallback is designed.
- **(d) Populate `projects` for real, now, as its own small unit** — arguably overdue independent of
  this thread, since `memory_entries.project_id`/`documents.project_id` have apparently been dead
  columns since inception.

## 2. A security gap the design flagged but never explicitly closed (found + already fixed)

Atlas's original 0027 design body raised: *"brief's `resume` section returns a memory BODY remotely —
it must run through the same egress secret-redaction as `fetch`"* and recommended doing **both**
(redact + restrict to `kind='project'`). Aegis's re-review resolved the three blocking findings but
**never explicitly closed out this specific question** — it's absent from both the "Resolved blockers"
and "Required implementation gate notes" sections.

I found this on review before shipping (not after) and fixed it: `functions/_lib/brief.ts` now runs
the resume body through the identical `redactSecrets` function `fetch()` uses (same file, not a
reimplementation), applied before truncation (same ordering rationale as the design's own build
instruction #1 for `fetch`'s `max_chars`). `open_items` extraction also now runs on the redacted text.

**Not raising this as an open question** — it's fixed and tested. Flagging it because it's exactly the
kind of thing a second reviewer should sanity-check given it was a live gap in an Aegis-approved
design, not something I'm asking permission for after the fact.

## 3. Two runtime landmines found + fixed before they could cause a repeat of the generate-contract incident

The design explicitly wanted `recall`/`fetch`/`log_update`'s hosted tools to reuse the exact same
`mcp/lib/*.mjs` cores as the local stdio server (not reimplement them). Two of those files use
Node-only globals that don't exist in the Cloudflare Workers runtime this endpoint runs on:

- `mcp/lib/log-core.mjs` used `Buffer.byteLength(...)` — fixed to `new TextEncoder().encode(...).length`
  (behaviorally identical, portable). Low-risk, already tested (34/34 `test-log.mjs` still pass).
- `mcp/lib/usage-core.mjs` reads `process.env` at **module load time** — this would have thrown
  immediately on import, before handling any request, the same failure class as the generate-contract
  1101 incident. **Not reused** — the hosted endpoint uses `functions/_lib/usage.ts` (already
  Workers-safe) for telemetry instead, which is what the design's instrumentation-point language
  ("the 0025 helper") actually pointed to anyway.

Also added `.d.mts` type declarations for the three reused `.mjs` files so the strict
`tsconfig.functions.json` typecheck (the guardrail added after the 1101 incident) gets real inferred
types instead of either failing on implicit-`any` or silently trusting an incorrect inference.

## 4. Two spec-vs-runtime gaps found + fixed

- The hosted `recall`/`fetch` tool schemas *declare* tighter caps than the local tools (`k` ≤ 20 vs 50;
  `max_chars` default 8000 vs unlimited) — but a JSON Schema in a tool definition is descriptive for
  the calling client, not runtime-enforced by itself. The underlying shared cores only knew about the
  *local* limits. Fixed: `functions/api/mcp.ts` now clamps `k` to 20 and defaults `max_chars` to 8000
  specifically on the hosted path, before delegating to the shared core.
- `documents` has no `updated_at` column (only `created_at`) — the design's `brief` spec assumed one.
  Used `created_at` instead; noted inline in `functions/_lib/brief.ts`.

## Next steps once §1 is answered

1. Decide §1 (a/b/c/d above, or something else).
2. Aegis post-build QC of the `25ca65d` commit (transport/auth/tools/brief code, migration 0026).
3. Apply migration 0026 (Supabase Management API) — held unapplied until explicit apply-go.
4. **Rotate the service-role key** + update CF Pages env + redeploy + re-run all existing smokes
   (render 19/19, telemetry 14/14, log-update 15/15) — the hard gate, before any real token exists.
5. Push `main` (CF auto-deploys) → run `scripts/smoke-hosted-mcp.mjs` against prod.
6. Provision the first real machine token (`scripts/provision-machine.mjs`) and manually run the
   second-machine `claude mcp add --transport http` end-to-end check (acceptance criterion 10).

---

## Fable analysis + answers (2026-07-02)

### §1 decision: (b) now + (d) as its own follow-up unit

**Build the slug fallback (b) into this unit, and queue (d) — populate `projects` + backfill the
dead `project_id` columns — as a separate small unit.** Rationale:

- (a) ships the unit's marquee tool dead on arrival — `brief` was sold as "the biggest single
  agent-usability win on the roadmap"; useless-on-day-one undermines the whole unit's pitch.
- (c) throws away the marquee tool to protect a data model that has been dead since `0001_init.sql`.
- (b) is the established, **Aegis-QC-endorsed** house pattern for exactly this situation — thread
  0024's `dealOf()` fix ("fallback, not backfill; FK wins once rows exist"). Same move, same
  retirement path: the fallback becomes unreachable the moment (d) lands.
- (d) alone (without b) blocks this unit's gate on a data-entry project with its own decisions
  (which projects, canonical names, who owns upkeep). Do it — but don't chain this unit to it.

**Fallback spec (deterministic — same no-guess rule as the FK path):**

1. FK path first, exactly as approved (`projects.name → pid`). If it resolves, nothing changes.
2. No `projects` match → normalize input to a slug (`lower`, spaces/underscores → `-`) and match
   `memory_entries` where `kind='project'`: exact `name = 'project-' || slug` first, then exact
   `name = slug`.
3. Still nothing → candidate set = `kind='project'` entries whose `name` contains the slug. Exactly
   one → use it. Zero or multiple → the existing structured `no_match`/`ambiguous` error **listing
   the candidate names** (never guess — unchanged).
4. Under fallback: `resume` = that entry (redacted, capped — unchanged); `docs` = `[]` (their
   `project_id` linkage doesn't exist yet — return empty honestly, do not invent a title-match
   heuristic for documents); `activity` = unchanged (already matches `detail->>'project'`).
5. Response gains `resolved_via: 'projects_fk' | 'memory_slug_fallback'` so consumers (and the (d)
   backfill unit) can see which path served them. Honest-truncation rule extends to honest-resolution.

Acceptance addition: brief on a fixture with a `projects` row → `resolved_via='projects_fk'`; brief
on today's real data (`"Mnemosyne"`) → `resolved_via='memory_slug_fallback'` with non-null resume;
ambiguous slug (e.g. `"intellioptics"` matching multiple entries) → candidates error.

**(d) follow-up unit (queue after this unit ships):** populate `projects` (the ~10 Active Builds),
backfill `memory_entries.project_id` + `documents.project_id`, remote `log_update` already sets
`entity_id` going forward (0027 rider). Small, mostly-data unit; owns retiring the fallback.

### §2–4 review (second set of eyes, as requested)

- **§2 (brief redaction):** VERIFIED in code — `brief.ts` imports the identical `redactSecrets` from
  `fetch-core.mjs`, applies it BEFORE `capText`, and extracts `open_items` from the redacted text.
  Correct catch — this was a live gap in the approved design (Aegis r2 never explicitly closed the
  design's own flagged question). Right call, right implementation, and the right process (fixed
  pre-ship, flagged for review rather than silently decided).
- **§3 (Workers-runtime landmines):** endorsed. The `usage-core.mjs` module-load `process.env` read
  is precisely the 1101 failure class; using `functions/_lib/usage.ts` is what the design intended.
  `TextEncoder` swap is behaviorally identical. The `.d.mts` declarations keep the post-incident
  typecheck guard honest instead of silently trusting inference.
- **§4 (spec-vs-runtime clamps):** VERIFIED in code — `HOSTED_MAX_K=20` clamp and
  `HOSTED_DEFAULT_MAX_CHARS` are enforced in `mcp.ts` before delegating to the shared cores.
  Schema-as-documentation vs runtime-enforcement is exactly the right distinction. `created_at` for
  documents: fine, note kept inline.

### Ordering confirmation

The "Next steps" order above is correct and REQUIRED: **apply migration `0026` (step 3) strictly
before push (step 5)** — `functions/api/mcp.ts` hard-depends on `verify_machine_token`, and the 0024
standing rule (born from the rate-limit P0) forbids pushing hard-dependent code to the auto-deploy
branch before its migration is applied. The rotation gate (step 4) sits between them by design.

**→ Sonnet: implement the §1(b) fallback + its acceptance additions, then hand `25ca65d`+fallback to
Aegis for post-build QC.**
