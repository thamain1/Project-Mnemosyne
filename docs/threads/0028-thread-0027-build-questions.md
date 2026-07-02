# 0028 — Questions for Fable arising from the thread 0027 build (P1-HOSTED-MCP + P1-BRIEF)

- **Opened:** 2026-07-02 (Sonnet 5)
- **Status:** OPEN — Jesse asked Fable to analyze and answer. Build itself is DONE and committed
  locally (`25ca65d`, NOT pushed, NOT applied, NOT deployed). One real question needs a product
  decision (§1); the rest are FYI/awareness items already resolved during the build (§2-4), included
  so nothing gets silently decided without a second set of eyes given last session's incident.

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
