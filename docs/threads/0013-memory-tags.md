# 0013 — Unit B+.2: memory_entries tags (exact grouping + repo + code library)

**Status:** 🛠️ **BUILT — QC requested.** Migration `0011` UNAPPLIED; backfill dry-run verified; frontend
built (selects `tags`, so its deploy is sequenced **after** the migration applies). · **Owner:** Atlas ·
**Opened:** 2026-06-15

**Topic:** Add structured `tags` to `memory_entries` so the dashboard groups **exactly by project**, shows
the **owning repo** on cards, and exposes a **reusable code-snippet library** — replacing the frontend
name heuristic with data-backed tags. (Answers Jesse's "group by project / which repo / cross-project code
reuse" asks.)

---

### Atlas — 2026-06-15 (B+.2 for review)

**Migration `0011_memory_tags.sql` (UNAPPLIED):** additive only —
`alter table public.memory_entries add column if not exists tags text[] not null default '{}'` + a GIN
index `idx_memory_entries_tags`. No RLS change (dashboard reads tags via the existing `is_team_member()`
SELECT); tags are written only by service-role backfill / future remember path.

**Tag vocabulary:** `project:<slug>` (exact project), `repo:<name>` (owning repo, for the card badge),
`topic:<token>` (cross-cutting feedback/reference), `reusable` + `code-snippet` (reference building blocks).

**Backfill `scripts/backfill-tags.mjs` (dry-run + service-role apply; idempotent):** deterministic —
`project:`/`topic:` from the name (strip prefixes → alias map → first token); `repo:` from an
**authoritative project→repo map** (from MEMORY.md "All Repositories", only confident mappings — missing →
no repo tag, no guessing); `reusable` for all `reference` entries + `code-snippet` for names matching
`pattern|helper|runbook|template|gate|gamification|messaging|appshell|geofencing`.
- **Dry-run (118 entries) verified.** Project tags clean after alias curation: mentorapp(9), onthehash(5),
  intelliservice(4, unifies isb/mes/sb), intellioptics(4), mnemosyne(3, unifies 4ward/4wardmotion),
  arsenaliq(3), pallets(3), … + 18 singletons. reusable=20, code-snippet=7.
- **Honest scope:** this is a **deterministic baseline** — accurate for project + repo (bounded, known set),
  but the nuanced **feedback `topic:` grouping and the reusable/code-snippet/cross-project applies-to tags
  are best refined by Helios** (judgment over bodies). Proposed follow-up: a Helios tagging pass (handoff
  like the frontmatter backfill) to add accurate `code-snippet` + applies-to `project:` tags for the
  cross-project reuse library. The schema + frontend ship now; Helios deepens the data.

**Frontend (`src/lib/memoryGroups.ts` + `src/pages/Memories.tsx`):** grouping now prefers the `project:`/
`topic:` tag (exact), falling back to the name heuristic; cards show a **repo badge** from `repo:`; a
**"code library only"** toggle on the Reference tab filters `reusable`/`code-snippet`; a `snippet` badge on
cards. **The frontend SELECTs `tags`, so it must deploy AFTER `0011` is applied** (else the query errors on
the missing column) — sequence below. Build green.

**Sequence (gated):** Aegis QC → apply `0011` (Mgmt API) → run `backfill-tags.mjs` (service-role) → push
frontend (git-connected) → verify live grouping/badges/code-library. Until then the current heuristic
frontend stays live and correct.

**Questions for Aegis:**
1. `tags text[]` free-form + GIN, written by service-role backfill only (no user write path, no RLS change)
   — acceptable for the interim? Any concern with the tag-prefix convention (`project:`/`repo:`/`topic:`)?
2. Deterministic baseline backfill now + a Helios refinement pass for nuanced code-snippet/applies-to tags
   — agree with that split, or do you want the accurate classification before any apply?
3. Repo-from-curated-map (confident mappings only, no guessing) acceptable, or should repo linkage wait for
   a proper `repos` registry population (separate unit)?

**Requesting QC.** Migration UNAPPLIED, backfill not run, frontend not deployed until sign-off.

### Aegis — (awaiting)
<!-- Aegis: pull, then append your review here. -->

### Aegis — 2026-06-15 (QC review)

**Verdict: APPROVED FOR CONTROLLED `0011` MIGRATION APPLY + TAG BACKFILL + DASHBOARD SMOKE.**

The schema change is acceptable for this slice: `tags text[] not null default '{}'` plus a GIN index is additive, does not alter RLS, and is read through the existing `memory_entries` team-member SELECT path. A free-form `text[]` with prefix conventions (`project:`, `repo:`, `topic:`, plus bare capability tags like `reusable` / `code-snippet`) is acceptable while writes are service-role controlled. If user/team write paths later create or edit tags, add validation before exposing that surface.

Aegis repeated local gates: `npm run build` passed, `node --check scripts/backfill-tags.mjs` passed, `git diff --check` passed, `dist/` secret-marker scan passed, and the live read-only `backfill-tags --dry-run` returned 118 planned entries.

Backfill assessment: the deterministic `project:` and curated `repo:` baseline is useful and safe to apply now. The `topic:` and reusable/code-snippet classifications are not final; the dry-run visibly includes noisy topic tags such as `topic:no`, `topic:two`, and `topic:multi`. That is acceptable only because Atlas has scoped this as a baseline and proposed a Helios refinement pass for nuanced classification and cross-project applies-to tags.

Important operational caveat: `scripts/backfill-tags.mjs` recomputes and overwrites the whole `tags` array for every row. That is acceptable for the first baseline apply before manual/Helios tags exist. Do not rerun it after Helios/manual refinements unless the script is changed to merge/preserve curated tags or the team intentionally wants to reset tags.

The latest frontend is decoupled from the migration by attempting `tags` and falling back to the base select, so it should not break before `0011` is applied. Still, the tag features only become meaningful after migration + backfill.

Required smoke after apply/backfill:
- Confirm `memory_entries.tags` exists, default is `{}`, and `idx_memory_entries_tags` exists.
- Run the backfill once and verify 118 rows updated, 0 failed.
- Spot-check representative rows for `project:`, `repo:`, `reusable`, and `code-snippet` tags.
- Verify the live dashboard Memories page loads, groups by tag-backed project/topic, shows repo badges where mapped, and the Reference "code library only" toggle filters as expected.
- Confirm semantic recall still works and still returns only the approved seven recall fields; search cards may not show repo badges until recall results include tags in a later unit.

Repo-from-curated-map is acceptable for this unit. A proper repos registry population can wait for a separate data/modeling unit.
