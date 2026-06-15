# 0005 — Frontmatter backfill for skipped memory files (Helios)

**Status:** OPEN · **Owner:** Helios · **Opened:** 2026-06-15 by Atlas
**Topic:** Classify the memory files that were skipped from Phase-1 ingestion (no frontmatter `name:`) and
propose frontmatter so they can be backfilled into the brain. **Helios proposes; Atlas/Jesse apply +
re-ingest.** This is the first self-contained data-plane unit handed to Helios.

---

### Atlas — 2026-06-15 (handoff to Helios)

Phase-1 continuity-core ingestion is live (101 entries / 43 chunk-vectors). It **skipped every memory
file lacking a frontmatter `name:`** — they never got embedded, so they're invisible to recall. Your job is
to make them ingestible by proposing good frontmatter for each. This plays to your lane (bulk
classification / metadata extraction) and has **zero secret exposure** if you respect the exclusions below.

**Worklist (17 files), in the memory dir** `C:\Users\ThaMain1\.claude\projects\c--Dev\memory\`:

```
4wardmotion.md              intelliservice.md
claude-session-strategy.md  intellitax-interview-gaps.md
fastalpr-implementation.md  intellitax.md
impacttracker.md            mentorapp-desktop-layout.md
intellicity.md              sultanofswing.md
intellimetrics.md           zodiac-aos534.md
intellioptics-2.5.md
intellioptics.md
intellipour.md
intelliproperty.md
intelliservice-demo.md
```
Re-derive the set yourself before starting (glob `*.md`, keep those with no frontmatter `name:`) in case
it has changed — but the count and list should match the above.

**HARD EXCLUSIONS — never read, classify, or send to the API:**
- `MEMORY.md` — this is the **index**, not a memory entry. Leave it alone.
- `stripe-keys.md` — **secret-bearing; quarantined.** Do not open it. (Per Jesse: kept local, not vaulted.)
- Anything matching the secret denylist (`*-keys.md`, `*_keys.md`, `*.key`, `*.pem`, `credentials*`,
  `.env*`). Run the existing scan logic conceptually before reading any file; if a file trips the secret
  scanner, **quarantine it and report it — do not classify it.**

**For each file, propose frontmatter in exactly this shape** (matches the existing convention, e.g.
`project_4ward.md`):
```markdown
---
name: <kebab-case slug — default to the filename without `.md`>
description: <one concise line; what this file is, used for recall relevance ranking>
metadata:
  type: user | feedback | project | reference
---
```
- `name`: default to the filename stem (e.g. `impacttracker.md` → `impacttracker`). Only deviate if the
  stem isn't already kebab-case.
- `type`: pick from the four — `project` (ongoing work/goals/state), `reference` (pointers/runbooks/
  external resources), `feedback` (how-we-work guidance), `user` (who Jesse is). Most of these are
  `project` or `reference`; justify any `feedback`/`user` call in one phrase.
- `description`: derived from the file's actual content, ≤ ~160 chars, no secrets.

**Output (your lane — do NOT edit the canonical memory files):**
1. Write your proposals to **`docs/helios/frontmatter-backfill.md`** (create the dir) — one section per
   file: filename, proposed frontmatter block, and a one-line rationale for the `type` choice. Flag any
   file you'd recommend **not** ingesting (e.g. fully superseded/archived) with a reason.
2. Append a **`### Helios — YYYY-MM-DD`** entry to **this thread** summarizing: how many classified, the
   type distribution, anything quarantined/skipped, and any judgment calls you want Atlas/Aegis to confirm.
3. Commit + push (coordination artifacts — `docs/threads/**` and your `docs/helios/**` notes — are
   push-OK without asking, per standing auth). Trailer:
   `Co-Authored-By: Helios (Gemini) <helios@4wardmotions.com>`.

**Boundaries (reminder):** reads scoped to the worklist above; **no DB writes**, no migrations, no edits to
`CLAUDE.md`/`AGENTS.md`/migrations/app source. You only *propose* — Atlas reviews, applies the approved
frontmatter to the real memory files, then re-runs the embed→persist pipeline so they land in the brain.

**Definition of done:** `docs/helios/frontmatter-backfill.md` covers all 17 (minus any justified
exclusions) with valid, convention-matching frontmatter blocks, plus your thread summary. Then Atlas
reviews → applies → re-ingests; Aegis spot-checks the resulting entries if it wants.

### Helios — (awaiting)
<!-- Helios: pull, do the work, append your summary here. -->
