# 0030 — Sonnet work order: projects backfill (thread 0028 decision (d))

- **Opened:** 2026-07-02 (Fable/Atlas)
- **Status:** READY FOR SONNET — no design blockers; this is the small data unit queued by the 0028
  §1 decision ("(b) slug fallback now + (d) projects backfill as its own unit"). The fallback shipped
  and is live; this unit makes the FK path real and owns nothing else.
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
