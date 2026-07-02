# 0030 — Sonnet work order: projects backfill (thread 0028 decision (d))

- **Opened:** 2026-07-02 (Fable/Atlas)
- **Status:** ✅ **DONE (Sonnet 5, 2026-07-02).** `scripts/backfill-projects.mjs` written (dry-run
  capable, idempotent — case-insensitive match-then-create for projects, `project_id IS NULL`-only
  updates for the two backfill steps), run for real, re-run to prove idempotency (0 new/changed rows,
  identical report). Acceptance proven two ways: a dedicated one-off
  (`scripts/verify-projects-backfill.mjs`, 10/10) against live prod, and the full
  `scripts/smoke-hosted-mcp.mjs` suite (60/60 — its adaptive fallback probes needed a real fix, see
  below, not just a rerun). `npm run build` green; `node --check` clean on all changed/new scripts.
  Committed locally, **not pushed** (push only on Jesse's word, per the work order).

  **Backfill report:**
  - **Step A (projects seeded):** 14 created, 0 pre-existing. Full canonical roster from the work
    order, `owner_id` = Jesse's `team_members.id` (resolved by email).
  - **Step B (memory_entries.project_id):** 44 mapped, 25 left `NULL` (listed with reasons in the
    script's own output — a mix of "not in the canonical active-builds list" (ArsenalIQ, EagleEye,
    FastALPR, IntelliCity, IntelliMetrics, IntelliPour, IntelliProperty, Just-As-I-Am, MavenPark,
    AllSigns, SultanOfSwing, Zodiac, KSOS) and genuine dual-project ambiguity (OnTheHash+Perks
    crossover/commercial entries) or content-vs-name-prefix mismatches (`mentorapp-multitenant` is
    actually about Just-As-I-Am; `p2p-website` is an unrelated client, not P2PNow). None guessed.
  - **Step C (documents.project_id):** 13/13 mapped, 0 left `NULL`. 12 client contracts via
    title-prefix (OnTheHash ×3, GIAV ×5, Spencer/SpencerLeadGen ×4); the 1 remaining document (the
    company White Paper) turned out to have `origin='rendered'` — produced by Mnemosyne's OWN
    Document Factory, not a client deliverable — matching the work order's own hint ("this repo's
    rendered docs should link") once I caught it; mapped to Mnemosyne. **Found and fixed a bug in my
    own first pass**: I initially left it `NULL` on title-prefix grounds alone, then re-read the
    acceptance text, spotted the `origin` signal I'd missed, and re-ran the (idempotent) script to fix
    it — recorded here rather than silently corrected.
  - **Step D (Mnemosyne resume entry):** Investigated first (see the script's own header comment for
    the full root-cause chain): the one bulk `ingest-embed.mjs` run (2026-06-16) captured the file
    under its PRE-RENAME name (a `project-4ward` entry from that exact batch proves it); the local
    file was renamed to `project_mnemosyne.md` afterward but the bulk ingest was never re-run.
    Decision: did NOT re-run the full bulk pipeline (out of scope, would sweep in unrelated stale/
    renamed files) — created ONE entry via the sanctioned `ingest_memory_entry` RPC instead (file-backed
    provenance, matching its 69 siblings), body = the current top RESUME bullet (not the full ~100KB
    historical section — see script comments), linked to the Mnemosyne project row.
  - **Adaptive-probe fix (found during acceptance, not a regression):** `smoke-hosted-mcp.mjs`'s
    thread-0028 fallback probes picked `4wardmotion`/`4wardmotion-site-c` by alphabetical-first/prefix
    search over `memory_entries` alone — now that `projects` is non-empty, those specific names are
    legitimately resolved by the FK path first (by design, FK wins), so the probes started hitting the
    wrong branch. Fixed by filtering candidates against live `projects.name` so the probes only ever
    pick entries the FK path genuinely cannot reach.

  **Out of scope, confirmed untouched:** the slug fallback itself (unchanged, still live for the 25
  left-`NULL` entries and anything else not in `projects`); `activity_log.entity_id` historical
  backfill (forward-fixed by the 0027 rider only, per the work order); any CRM bridge work.
- **Audience:** Sonnet 5. Self-contained per the handoff SOP.
- **Ground rules:** NO new migration (schema for `projects`, `memory_entries.project_id`,
  `documents.project_id` has existed since `0001_init.sql` — the columns are just empty). This is a
  data unit driven by ONE idempotent service-role script. `main` is synced with origin — normal
  commit flow, push only when Jesse says. Commit → brain-log per standing rules.

## Why

`brief`'s primary resolution path (`projects.name → project_id` FK chain) is dead on arrival against
real data: `projects` has 0 rows, `memory_entries.project_id` and `documents.project_id` are 100%
null (verified 2026-07-02, thread 0028 §1). The live fallback covers most projects, but **the brain
has NO `kind='project'` entry for Mnemosyne itself** — `brief("Mnemosyne")` returns `no_match` today
(gate-run finding, 2026-07-02). Backfilling retires nothing (the fallback stays; FK wins by design)
but makes `brief` deterministic, `docs` non-empty, and future CRM/lead-gen linkage (P2-BRIDGE)
possible.

## The work

### 1. `scripts/backfill-projects.mjs` — ONE idempotent script (the whole unit)

Service-role, `--env-file=.env.local`, `--dry-run` flag that prints the full plan without writing.
Idempotent per the idempotent-seeds rule: match-then-create/update, NO `if count > 0 return` gates.

**Step A — seed `projects`.** One row per active build. Canonical list (name → summary hint), from
the memory roster; names are the `brief` lookup keys so they MUST match what a teammate would type:

| name | note |
|---|---|
| Mnemosyne | this repo; shared second brain |
| GIAV | Beth Underhill; giav.pages.dev |
| GIAV Academy | done unit, keep for history linkage |
| OnTheHash | onthehash.com |
| Perks & Plays | perksandplays.com; alias "The Playbook" |
| IntelliTax | |
| ImpactTracker | |
| MentorApp / P2PNow | p2pnow.org |
| SpencerLeadGen | docs-only pilot |
| Pallets | |
| Pallets-Site | |
| IntelliService | Master/ISB/SB/MES family — ONE row (per-build rows only if entries force it) |
| IntelliOptics 2.5 | |
| 4wardmotion-site | 4wardmotions.com |

Fields: `name`, `status` ('active'; 'done' for GIAV Academy), `summary` (one line),
`owner_id` = Jesse's `team_members.id` (look up by email `jmorgan@4wardmotions.com`), default
sensitivity. Upsert key: `name` (case-insensitive match-then-create).

**Step B — backfill `memory_entries.project_id`.** For each `kind='project'` entry, derive the
project from its `name` slug (e.g. `intellioptics-2-5-*` → IntelliOptics 2.5; `project-perks*`,
`project_giav*` → per prefix). Build the mapping in code as explicit prefix rules, print every
assignment in dry-run. **Ambiguous or unmappable → leave NULL and list it in the report — never
guess** (same no-guess rule as brief itself). Only update rows where `project_id IS NULL` (a re-run
must not clobber manual corrections).

**Step C — backfill `documents.project_id`** for the 13 existing documents, derivable from title /
existing deal linkage; same NULL-and-report rule for unclear cases.

**Step D — create the missing Mnemosyne resume entry.** First INVESTIGATE why the mirror never
pushed `project_mnemosyne.md` to the brain (`scripts/mirror-push.mjs` — is the file excluded, or was
the mirror last run before the file existed?). If the mirror is the right channel, run/fix it; if
not, create the entry via the sanctioned ingest path (`ingest_memory_entry` RPC or the `remember`
core — NOT a raw insert) with `kind='project'`, `name='project-mnemosyne'`, body = current RESUME
block content, linked to the Mnemosyne `projects` row. Report which channel you used and why.

### 2. Acceptance (prove via `scripts/smoke-hosted-mcp.mjs` additions or a one-off check script)

1. `brief("Mnemosyne")` → `resolved_via='projects_fk'`, non-null resume, `docs` array non-empty
   (this repo's rendered docs should link) — the exact call that returned `no_match` on 2026-07-02.
2. `brief("GIAV")` and `brief("Perks & Plays")` → `projects_fk`, non-null resume.
3. The adaptive fallback checks in `smoke-hosted-mcp.mjs` still pass (fallback must still work for
   any entries left unmapped).
4. Script re-run (idempotency) → zero new rows, zero changed rows, same report.
5. Backfill report committed into this doc's status section: N projects seeded, N entries mapped,
   N left NULL (listed), N docs mapped.

### 3. Out of scope

- Retiring the slug fallback (stays by design — FK simply wins).
- `activity_log.entity_id` backfill for the ~112 historical project rows (forward-fixed by the 0027
  rider; historical backfill only if trivially derivable, and then as its own dry-run-reported step).
- Any CRM bridge work (P2-BRIDGE is the NEXT unit and builds on this).

## Close-out

Explicit-path commit(s), brain-log each commit, update this doc's status line with the backfill
report, **push only on Jesse's word**, stop. Aegis QC gate: the acceptance checks above + spot-check
of the mapping report (data QC, not code QC — there is no schema or endpoint change in this unit).
