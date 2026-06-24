# Builder Onboarding — 4ward Claude Code Memory Architecture

Set your Claude Code memory up the way the team does: cheap to carry every turn, never silently truncated, instant to switch between projects, and resilient if a repo is offline. Do this once per machine.

---

## Why this exists (the tradeoff)

A "default" Claude Code session carries **0 standing memory tokens** — but that's a trap. With no memory index it has to *rediscover* the build every session: reading files, `git log`, grep, asking you. That cold-start is routinely **20–50K+ tokens**, slow, and **lossy** — code archaeology recovers *what* the code is, never the *why*, the gotchas, or the guardrails ("these builds diverge," "never push to branch X"). So it re-asks you or guesses, and **repeats past mistakes**. It's also non-deterministic.

Our approach pays a **small fixed cost (~4.6K tokens/turn)** for an always-loaded index, which buys instant orientation and — crucially — **stores the knowledge that can't be recomputed from code at all**. Classic index/cache tradeoff: pay a little continuously to avoid paying a lot repeatedly.

**Hard constraint to know:** `MEMORY.md` is injected into *every* session, and the harness **silently truncates it past ~24.4KB** (target ~17.1KB). An overgrown index drops critical rules on load without telling you. Keep it lean.

---

## The architecture (3 tiers + a switch command)

**Tier 1 — `MEMORY.md` = lean always-loaded index (< ~17KB).** Only what's worth paying for every turn:
- **Active Project** block (current focus + HEAD/state).
- **Active Builds roster** — one line per project: `name → path | branch | topic file`. Drives `/resume`.
- **User identity + standing feedback rules.**
- **STANDARD rules** (cross-cutting: verify-with-build, CF-git-connected deploys, redeploy-after-secrets, DNS-at-nameserver, etc.).
- **CRITICAL rules** — the disaster-preventers, promoted into the load window.
- Pointers to Tier 2.

**Tier 2 — `reference_index.md` = read on demand (NOT auto-loaded).** Full lookup tables (repos / Supabase DBs / CF+Render deploys / dev servers) + domain clusters (per-product gotchas, deploy/auth patterns). Opened when relevant, or surfaced via Mnemosyne `recall`.

**Tier 3 — per-project topic files.** Full detail, each opening with a `⭐ RESUME` block.

**`/resume <project>`** (`~/.claude/commands/resume.md`) — manual command you type after `/clear`. It resolves the name in the roster → reads the topic file's `⭐ RESUME` block → runs `git status` + `git log` → reports where-we-are / state / next-action / guardrails in ≤12 lines, then waits. Loads one project's context per switch, not all of them every turn. (It's manual because a shared working root can't infer which project you mean.)

---

## Per-project file convention (uniform; the memory file is the backup)

**REQUIRED for every project:** one **memory topic file** (`<slug>.md`) that **opens with a `⭐ RESUME` block** — `HEAD/branch · what's done · the ONE next action · guardrails`. It lives in the memory tree, **not the repo**, so it survives an unreachable/uncloned repo. The roster points here. *A project whose only state lives in an in-repo doc has no backup — create the memory file.*

**OPTIONAL mirror (multi-dev/shared repos only):** an in-repo `docs/CHECKPOINT.md` mirroring the `⭐ RESUME` block, so co-devs + their agents see it. It **never replaces** the memory file. `/resume` reads the memory file first, then the in-repo checkpoint if present.

---

## Standing rules that keep it fresh (at write-time, not read-time)

- **Register state on push** — on `git push`, bump the `⭐ RESUME` block (HEAD/state) in the topic file (and MEMORY.md if it's the active project).
- **Every commit → Mnemosyne** — `log_update action=work.commit` with project/repo/branch/SHA/summary, so there's a recall-able trail.
- **Verify-before-demote** — never delete to shrink; relocate detail to a topic file (backfill first if needed) and leave a loud one-line pointer. Lossless.

---

## How to adopt it (step by step)

Everything you need is in the **Mnemosyne shared brain** — pull it and follow it:

1. `recall "Claude Code memory architecture 4ward standard"` → entry **`cc-memory-architecture-4ward-standard`** (the rationale + full spec).
2. `recall "memory migration checklist"` → entry **`cc-memory-migration-checklist`** (10-phase, lossless, with verification gates — run it through Claude Code on your machine).
3. `recall "per-project file convention"` → entry **`cc-memory-per-project-convention`** (the `⭐ RESUME` / backup convention).

Work the checklist top to bottom. Key gates: capture a **baseline** (size + any generator row counts) before you start; **verify-before-demote** every section; if you have a table-parsing generator, point it at both `MEMORY.md` + `reference_index.md` and confirm **row counts are unchanged**; finish with `MEMORY.md` under ~17KB and `/resume` working on two projects.

**Reference result on the first machine:** `MEMORY.md` 77.7KB → ~18KB (≈77% cut), fully loads, zero data lost, generator output identical.

---

*Questions or improvements: log them to Mnemosyne (`log_update`) so the next builder gets them too.*
