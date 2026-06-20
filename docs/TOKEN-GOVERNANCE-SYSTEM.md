# Operating System for Token-Efficient, Rule-Governed Work

**Status:** FINAL (v1.5) — consensus reached (Jesse + Atlas + Aegis; Helios approved the underlying direction). v1.4 memory architecture (§16, local-canonical + Mnemosyne one-way mirror) + Aegis guardrails §17 accepted with the blocking/fast-follow split in §18. Hard-governance floor (§13) and git-vs-database boundary (§14) unchanged. Ready to implement per §18 sequence.
**Author:** Atlas (Claude Opus 4.8); reviewed by Helios (Gemini), Aegis (Codex)
**Reviewers:** Aegis (Codex — correctness/security QC), Helios (Gemini — data plane)
**Date:** 2026-06-20
**v1.1 changes:** reframed token-savings claim around prompt caching (§3.1); elevated subagent
search discipline to the primary token pillar (§4.1, §3.2); softened Mnemosyne-as-primary to a
knowledge-hygiene justification pending Helios He1/He3; added over-engineering design-risk
caution (§8); corrected success metrics to match (§10).
**v1.2 changes:** incorporated Helios review (§11) + Aegis revisions (§12) + Aegis final schema
(§13). Body updated to converged design: CI + protected branches as canonical gate with hooks as
fast feedback (§5/H1); tiered write-back rule replacing "and/or" (§4.2); auditable migration
manifest + archive + retrieval tests (§7); measured token baseline (§10). Clarified the
**git-vs-database asymmetry** — secrets/contracts/docs are forbidden in git but *sanctioned
(often canonical) in the Mnemosyne database*, which is the business-continuity/CRM/document store
and partner-retrieval point (§4.2, §13.3, §14 caveat #3); Mnemosyne-write governance is a separate
layer (Vault + `contract-scan.ts`) from the git-scoped H1/CI gate. Added §14 with three Atlas
caveats (CI setup cost; defer per-model adapter generation; git-vs-database asymmetry). The Aegis
§13 schema is the accepted target spec; §0–§10 are now consistent with it.
**v1.3 (FINAL):** Aegis's four acceptance conditions from §12 are all satisfied — measured token
baselines (§7.8, §10), hard recall caps (§4.2, §13.4), auditable migration manifest + archive +
retrieval tests (§7, §13.6), and a clear canonical-local-state vs. Mnemosyne-recall distinction
(§4.2, §13.3). No open review items remain. Locked for implementation per the §13.7 rollout order.
**v1.4 changes:** revised the memory architecture (§16) after working it through with Jesse —
**rejected** Mnemosyne-as-primary (pull-from-DB) as too risky (blind spots, round-trips, changing
what the agent relies on to function); **adopted** local-canonical + Mnemosyne-one-way-mirror +
fix-truncation-locally (tiering + dense machine-first wording). Supersedes §3.1/§4.2 primary-brain
framing; §13 floor and §14 boundary untouched. New Aegis questions M1–M5 (§16.4).
**v1.5 changes:** Aegis answered M1–M5 with nine guardrails (§17, no objection to the
architecture). Atlas + Jesse accepted all nine, split into **blocking** (G1/G3/G5/G7/G9 — the
safety floor that gates trusting the mirror and running the trim) vs. **fast-follow** (G2/G6/G8 —
partner-experience hardening of a working system), recorded as acceptance criteria in §18.
Consensus reached; document FINAL.
**Scope:** Cross-project. Governs how every Claude Code session (and the Mnemosyne-connected
agent trio) loads context, applies rules, and uses tokens — across GIAV, OnTheHash, Perks,
IntelliTax, Mnemosyne, and all future work.

---

## 0. Problem statement

The current governance system is **soft and front-loaded**:

1. **All knowledge loads on every turn.** `MEMORY.md` is ~62.6 KB / 337 lines and the harness
   is *already truncating it* ("Only part was loaded"). `CLAUDE.md` adds more. This is a fixed
   token tax paid on **every single message**, all session long, whether or not the loaded
   facts are relevant to the task.

2. **Rules depend on model attention, not enforcement.** The four standing rules
   (no-contracts-in-repos, 14-day package rule, no-AI-disclosure-in-contracts,
   no-vendor-names-in-client-docs) live as `CLAUDE.md` prose. They are obeyed only if the model
   reads and remembers them. Evidence they drift: the no-contracts rule has **already been
   violated** (3 MOU files committed under `MentorApp/docs/`).

3. **Truncation is a correctness risk, not just cost.** Because `MEMORY.md` is truncated,
   rules or active-project state near the bottom may silently fail to load — so the system gets
   *less reliable* exactly as it grows.

4. **The brain we built is underused.** Mnemosyne is a cloud semantic-recall database designed
   to return knowledge *on demand*. Yet bulk knowledge still lives in always-loaded flat files,
   paying rent every turn instead of being pulled only when relevant.

**Goal (reframed in v1.1 — see §3.1):** a system that is (a) **robust** — critical rules
enforced deterministically, not by hope; (b) **knowledge-hygienic** — durable, searchable,
multiplayer, no single point of failure; (c) **lossless** — no reduction in functionality or
recall quality; with (d) **token discipline as a secondary, honestly-scoped benefit** — real,
but smaller than first assumed once prompt caching is accounted for. Embedded uniformly across
every model, workflow, and the agent trio.

> **Framing note (v1.1):** the original draft sold this primarily as a *token-savings engine*.
> That headline was overstated — prompt caching means the always-loaded prefix is far cheaper
> per turn than its raw size suggests (§3.1). The honest pitch is **robustness + knowledge
> hygiene first, token discipline second.** This reframing makes the case stronger, not weaker:
> the load-bearing justifications (hard rule enforcement, no-SPOF knowledge) don't depend on the
> token math holding.

---

## 1. Core principle: the enforcement spectrum

Every governance mechanism sits on a spectrum from **soft** (model reads it, *should* comply)
to **hard** (harness enforces it deterministically, model cannot bypass). The central design
move is to **promote each rule to the weakest layer that still guarantees it.**

| Layer | Enforced by | Reliability | Token cost | Right for |
|-------|-------------|-------------|------------|-----------|
| Always-loaded files (`CLAUDE.md`, `MEMORY.md`) | Model reading each turn | Soft, drifts, truncates | **High (every turn)** | Thin index + operating protocol only |
| On-demand files (topic files) | Model `Read`s when relevant | Soft but scoped | Paid only when read | Per-project detail |
| Mnemosyne recall | Model calls `recall` when relevant | Soft but scoped + semantic | Paid only per recall | Bulk durable knowledge |
| **Hooks** (`settings.json`) | **Harness runs a script** | **Hard — deterministic** | Near-zero | "Always do X" / "never allow Y" |
| **Permissions** (allow/deny/ask) | **Harness, pre-tool** | **Hard — blocks call** | Near-zero | Dangerous commands, protected paths |
| Skills / slash commands | Invoked on demand | On-demand procedure | Paid when invoked | Reusable workflows |

**Token insight:** hooks and permissions are *near-free* in tokens (they live in the harness,
not the context window) **and** maximally reliable. Always-loaded files are the *most* expensive
and *least* reliable. So the strong system pushes rules **down** the table — out of prose, into
hooks — which improves robustness and cuts tokens simultaneously. These goals are aligned, not
in tension.

---

## 2. The three-tier memory architecture

Today Tiers 2 and 3 are collapsed into Tier 1 — that is the token leak. The fix is strict
discipline about which tier each fact lives in.

```
TIER 1 — ALWAYS LOADED  (minimize: pure per-turn tax)
  CLAUDE.md   → rules + operating protocol (the "how to work" contract)
  MEMORY.md   → ROUTER ONLY: one line per project → pointer to its topic file + recall hint
        │
        ├─► TIER 2 — ON DEMAND (Read only when working that project)
        │     project_giav.md, project_oth_*.md, intellitax.md, ...
        │     full detail, chronology, runbooks
        │
        └─► TIER 3 — RECALLED ON DEMAND (Mnemosyne cloud DB)
              semantic recall returns ONLY the memories relevant to the current task
              cross-project code library, lessons, decisions, reusable patterns
```

**Rule of placement:**
- A fact needed *every session regardless of task* → Tier 1 (rare; mostly rules + protocol).
- A fact needed *only when working a specific project* → Tier 2 (topic file).
- A fact that is *durable, searchable, and cross-cutting* → Tier 3 (Mnemosyne).

`MEMORY.md`'s job changes from *database* to *router*: it should answer "where do I look?" in
one line per project, never "what is the full state?"

---

## 3. Token economics — what actually saves tokens (be honest)

Not every reinforcement saves tokens. Conflating "correctness guardrail" with "token savings"
produces a weak system. Precise accounting:

| Lever | Saves tokens? | Mechanism |
|-------|:---:|-----------|
| **Subagents (Explore/Task) for search** | **Yes — the biggest real lever** | File dumps die in the subagent's context; only the conclusion returns to main. Targets the dominant cost (tool output), not the cached prefix. See §3.2. |
| Permissions allowlist | **Yes — modest, direct** | Fewer permission round-trips = fewer wasted turns/transcript. |
| Not re-reading / not re-deriving | **Yes — modest, direct** | Avoids duplicate large tool outputs in the transcript. |
| Trim `MEMORY.md` → router | **Smaller than assumed** | Cuts the always-loaded tax — but that tax is *cached* (~10% cost/turn), so savings are ~⅕ of raw size. Still worth doing for correctness (truncation) reasons. §3.1. |
| Mnemosyne recall-on-demand | **Unproven — possibly neutral** | Trades a *cached* flat tax for *uncached* per-recall injections that can also bust cache below them. Net effect pending Helios He1/He3. Justify on hygiene, not tokens. §3.1. |
| `PreCompact` / `SessionStart` hooks | **Indirectly** | Prevent re-deriving lost state (re-derivation = expensive re-reading). |
| Contracts-block / 14-day hooks | **No — correctness only** | Harness-side guardrails. Worth it, but not a token lever. Label honestly. |

### 3.1 The prompt-caching correction (the hole in the original thesis)

The original draft assumed the ~62 KB `MEMORY.md` is paid at full price on **every** turn. It
isn't. `CLAUDE.md` + `MEMORY.md` are a **stable prefix** — byte-identical at the start of every
turn — so Anthropic prompt caching serves them at roughly **10% of full token cost** after the
first turn. Consequences:

- **Trimming the always-loaded files saves real but modest tokens** — on the order of a fifth of
  what raw size implies. The stronger reason to trim is **correctness**: truncation (rules near
  the bottom silently not loading), not cost.
- **Mnemosyne recall cuts the *other* way on caching.** Recall injects *fresh, different* content
  mid-conversation. That content is **uncached**, and depending on placement it can invalidate
  cache for everything below it. So "move knowledge from always-loaded files into recall-on-
  demand" can be **token-neutral or net-negative** across a session with many recalls — while
  adding tool-call round-trips and latency.
- **Therefore:** adopt Mnemosyne-as-primary for **knowledge-hygiene** reasons (durable,
  multiplayer, searchable, no-SPOF) — *not* on a token-savings premise — until Helios validates
  the actual numbers (He1/He3). If recall proves token-neutral, that is still an acceptable
  outcome, because the hygiene case stands on its own.

### 3.2 Where the real token costs actually live

In a real working session the dominant token consumers are **tool outputs and transcript
length** — file reads, bash dumps, re-reading the same file, long multi-turn exchanges — **not**
the cached memory prefix. This inverts the priority order: the highest-leverage token levers are
the ones that keep bulk output *out of main context* in the first place. That makes **subagent /
Explore search discipline (§4.1) the centerpiece of the token story**, ahead of any memory-file
trim.

**The catch on recall (for Helios He1/He3):** a naive system that recalls broadly every turn is
**worse** than the flat file — uncached injections, repeated. The discipline is **recall
narrowly, when relevant** (1–3 targeted memories per task). The win, if any, comes from
*relevance filtering*, not from the DB itself — and that discipline should be enforced **hard**
(in `recall-core.mjs`, He3), not left to soft protocol.

---

## 4. The behavioral pillars

### 4.1 PILLAR — Search discipline (the primary token lever)

Per §3.2, this is the single highest-leverage token practice, ahead of any memory-file change.
Standing rule (to be encoded in `CLAUDE.md`, and reinforced by the permissions allowlist):

- **Any search spanning >2 files goes through a subagent (Explore/Task), never into main
  context.** The subagent reads the bulk; only its conclusion returns. This keeps the dominant
  token cost — tool output — out of the conversation entirely.
- **Never read whole directory trees** into main context to "look around." Delegate it.
- **Don't re-read a file already in context**, and don't re-derive a fact already established.
- Prefer a targeted `recall` or a single scoped `Read` over re-scanning a large topic file for
  one fact.

This pillar is partly *hard*-enforceable (the permissions allowlist nudges read-only fan-out
toward subagents) and partly soft (judgment about when to delegate). It is deliberately listed
first because it moves the most tokens.

### 4.2 Mnemosyne as primary brain — the recall protocol

> **⚠ SUPERSEDED by §16 (v1.4).** The "Mnemosyne-as-primary / recall-before-files" model below was
> **rejected** as too risky (blind spots, round-trips, changing what the agent relies on to
> function). The governing decision is now: **local md files stay canonical and passively read;
> Mnemosyne is a one-way mirror (backup + share + optional semantic search); truncation is fixed
> locally via tiering + dense wording.** Read §16 as authoritative; the text below is retained for
> the review trail only. The hard recall caps (§13.4) still apply *if/when* recall is used.

The strong system makes Mnemosyne the **primary durable knowledge store** *for knowledge-hygiene
reasons* (durable, multiplayer, searchable, no single point of failure — **not** on a token-
savings premise, per §3.1), with files as a fast local fallback for **non-secret operational
project state**. Secrets, contracts, and client documents recover through Mnemosyne/Supabase
continuity controls, not git or plaintext topic files. Standing protocol (to be encoded in
`CLAUDE.md`):

**On session start / project switch:**
1. Read Tier 1 (`CLAUDE.md` + the thin `MEMORY.md` router).
2. From the router, identify the active project's topic file — `Read` it only if the task needs
   its detail.
3. **`recall`** from Mnemosyne with a task-specific query before broad file reading — pull the
   1–3 most relevant memories (decisions, lessons, reusable code) for *this* task.

**During work:**
- Use Explore/subagents for any search spanning >2 files; never read whole trees into main context.
- Prefer a targeted `recall` over re-reading a large topic file when you need one fact.

**On durable outcome — tiered write-back rule (Aegis §12.2, replaces the old "and/or"):**
Destination depends on the *kind* of outcome. For **non-secret project state**, Mnemosyne is a
recall/index layer over a canonical *local* copy. For **secrets, contracts, and client
documents** — which by rule can never touch git — **Mnemosyne is itself the canonical shared
store** (the business-continuity / CRM / document-recovery system already built, with the Supabase
Vault for secrets). git and Mnemosyne are deliberately opposite: forbidden in one, sanctioned in
the other.

| Outcome type | Git repo / topic file | Mnemosyne | `MEMORY.md` |
|--------------|:---:|:---:|:---:|
| Critical operational state (non-secret) | **Required** (canonical, topic file) | Required index/summary | Pointer only |
| Project-specific detail (non-secret) | **Required** (topic file) | Optional | Pointer only if new route |
| Cross-project lesson / pattern | Optional (topic file) | **Required** | No |
| Temporary task note | No | Only if durable | No |
| Secrets / credentials | **NEVER** (not in git, not in plaintext topic files) | **Vault — canonical, partner-retrievable** | No |
| Contract / client legal content | **NEVER in a repo** (out-of-repo `contracts/` for source files only) | **Yes — sanctioned store** (docs / RAG / generate) | No |

- Use `log_update` for the activity/audit trail.
- **No single point of failure, applied per type:** recovery-critical *non-secret* state lives in
  a topic file **and** is indexed in Mnemosyne. Secrets/contracts **cannot** be mirrored to git,
  so their durability comes from **Mnemosyne's own backups** (Supabase PITR / export) plus, for
  contract *source files*, the out-of-repo `contracts/` folder. (This reframes §13.3
  `not_allowed_as_only_copy_for` — see §14 caveat #3.)

**Mnemosyne-write governance is a separate layer from git.** The H1/CI gate is git-scoped and
intentionally does **not** touch Mnemosyne writes. What enters Mnemosyne is governed
independently: the `/api/save-document` prohibited-content scanner (`functions/_lib/contract-scan.ts`)
and the Supabase Vault + RLS for secrets (`get_secret`). Mnemosyne is the *sanctioned* private
home for docs, contracts, and secrets — exactly what the git rule pushes them toward, not away.

**Budget guidance:** target a recall that returns ≤ ~2 KB (~500–800 tokens) for a focused task.
Caps are enforced **hard** in the data plane, not by this prose — `default_k=3`, `MAX_K=10`,
`max_payload_bytes≈4096`, and an initial-candidate `0.75` relevance threshold (to be calibrated
against real queries before freezing). A recall with no high-confidence match must return an
explicit "no confident memory found", not low-similarity filler (§13.4).

---

## 5. Concrete hook & permission specifications

All in **global** `~/.claude/settings.json` unless noted, so they span every repo.

### H1 — Contracts-block — HIGHEST PRIORITY (defense in depth, three layers)
Aegis (§12, §13.1) resolved the original open design question: **no single layer is the gate.**
Use all three, weakest-feedback-fastest to strongest-enforcement-last:
- **Layer 1 — harness `PreToolUse` hook (fast feedback):** block `git add`/`git commit` whose
  args or staged paths match `**/contracts/**`, `**/MOU*`, `**/SOW*`, `**/INVOICE*`,
  `**/docs/MOU*`, `**/docs/SOW*`, `**/docs/INVOICE*`. Catches it in-session, in seconds.
  *Bypassable* (other tools/scripts/sessions) — feedback, not the gate.
- **Layer 2 — local `.git/hooks/pre-commit` (per repo):** blocks the commit on the same patterns.
  Harder to dodge, but bypassable via `--no-verify` or a fresh clone — still not the gate.
- **Layer 3 — CI check + protected `main` (canonical gate):** a GitHub Actions job greps the diff
  for the forbidden patterns and fails red; branch protection then **refuses the merge**. Runs
  server-side, for every push, regardless of local setup — *this is the unbypassable enforcement
  point.*
- **Rationale:** converts an already-violated soft rule into a hard impossibility at merge.
- **⚠ Caveat #1 (Atlas) — CI has setup cost.** Layer 3 is canonical *only once it exists*. The
  repos are currently CF-Pages-git-connected for **deploys**, with no CI check stage or protected
  branches. So the **practical hard floor today is Layers 1+2**; Layer 3 is stood up per repo
  (`.github/workflows/governance.yml` + enable branch protection on `main`) as each repo is
  touched. Track which repos have Layer 3 live; until then, do not treat the rule as fully hard
  for that repo.

### H2 — 14-day package rule (PreToolUse on Bash) — require-approval, not just remind
- **Trigger:** `npm install` / `pnpm add` / `yarn add` / `pip install` / `gem install` /
  `cargo add` with a non-pinned, non-`@scoped`, non-lockfile target.
- **Action (Aegis §13.2 `package_14_day_rule`):** require a publish-date check and **block until
  checked or the user explicitly approves** — *not* a remind-and-continue. Exceptions pass
  through automatically: existing lockfile restore, explicitly-requested version, internal/org-
  scoped package, user-flagged active-CVE patch.

### H3 — Destructive-command deny (permissions)
- **Deny / ask** on `git push --force`, `git reset --hard`, `rm -rf`, force-push to default
  branches, etc. — per existing CLAUDE.md caution.

### H4 — SessionStart active-project injection (hook)
- **Action:** deterministically inject the *current active project* pointer block (path, branch,
  HEAD, "resume here") into context at session start — so it survives even if `MEMORY.md` is
  truncated. Source from a small dedicated file the hook reads.

### H5 — Write-back nudge (Stop / PreCompact hook)
- **Action:** on session stop or before compaction, if tracked files changed, emit a reminder
  to `remember` durable outcomes to Mnemosyne and update the relevant topic file.

### H6 — Permissions allowlist (via `fewer-permission-prompts`)
- Auto-generate an allowlist of common read-only Bash/MCP calls from transcripts to cut
  permission round-trips (indirect token savings + smoother flow).

---

## 6. CLAUDE.md operating protocol (behavior layer)

A short, explicit protocol section added to `CLAUDE.md` encoding the streamlining as standing
instructions. Draft contents:

1. **Context discipline:** Read Tier 1 always; Tier 2 only when the task needs it; `recall`
   from Mnemosyne (narrowly) before broad file reading.
2. **Search discipline:** Explore/subagents for any multi-file search; never dump trees into
   main context.
3. **Memory write-back:** durable facts → Mnemosyne (`remember`) + topic file; `MEMORY.md`
   gets one router line max.
4. **Recall discipline:** narrow queries; ≤ ~5 memories per recall; re-query rather than
   over-fetch.
5. **No re-derivation / no narration:** don't re-establish known facts, don't survey options
   you won't pursue (existing preference, formalized).
6. **Rule pointers:** the four standing rules are enforced by hooks H1–H3; the protocol
   restates them so the model cooperates rather than fights the guardrail.

---

## 7. Migration plan — hard safety floor first, then memory (Aegis §13.7)

Ship the unbypassable safety mechanisms before touching memory, so the highest-value protections
land first and the memory trim never runs ahead of its audit trail.

1. **H1 contracts-block** — Layers 1+2 everywhere now; Layer 3 (CI + protected `main`) per repo
   as touched (caveat #1).
2. **H2 package 14-day** install gate (block-until-checked).
3. **H3 destructive-command** permissions (deny/ask).
4. **H4 structured SessionStart hook** — *only if it can be made injection-safe* (§13.5: emits a
   constrained path/branch/HEAD/topic JSON block, never freeform text from agent-writable files).
5. **`MEMORY.md` → router migration, with a manifest and archive (Aegis §12.4 / §13.6):**
   - **Archive** the pre-migration file: `archives/MEMORY.pre-router.2026-06-20.md`.
   - **Manifest** mapping *every* retained fact → destination (topic-file path and/or Mnemosyne
     slug), with discarded items marked duplicate/stale + reason. *Migration before deletion.*
   - **Retrieval tests:** for representative facts, verify the topic file contains the fact **and**
     a `recall` query returns it — *before* deleting bulk content from Tier 1.
   - Only then replace `MEMORY.md` with the thin router. Show the diff before saving.
6. **Mnemosyne recall caps + no-match behavior** (§13.4): `MAX_K=10`, `default_k=3`,
   payload cap, candidate `0.75` threshold (calibrate first), explicit no-confident-match return.
7. **H5 write-back nudge + H6 permissions allowlist** (`fewer-permission-prompts`).
8. **Metrics last** (§13.8): instrument only after the workflows exist and produce real data —
   measure actual always-loaded token count before/after (not byte-size conversion, Aegis §12.1),
   then tune the relevance threshold.

---

## 8. Failure modes & guardrails (for Aegis to stress-test)

> **Design risk — over-engineering (read first).** Three tiers, six hooks, a recall protocol,
> and write-back nudges is a lot of apparatus, and **most of it is soft** (depends on the model
> following protocol — the very weakness §1 criticizes). The triggering problem was *one*
> already-violated rule (contracts in repos), which argues for *one hard hook*, not a framework.
> **Discipline: ship the 2–3 genuinely *hard* mechanisms first** (H1 contracts-block,
> permissions allowlist/deny, and the recall cap in `recall-core.mjs` if Helios endorses He3),
> encode the rest as a short protocol, and do **not** build heavy machinery whose correctness
> depends on the model's own compliance. Every soft component added is a future drift risk.
> Prefer the smallest system that makes the rules that *matter* impossible to break.



| Failure mode | Mitigation |
|--------------|------------|
| Mnemosyne DB unreachable → recall fails | Topic files (Tier 2) remain a complete local fallback for **non-secret operational project state**; secrets/contracts/client docs recover through Mnemosyne/Supabase continuity controls, not git/plaintext files. |
| Over-trimmed `MEMORY.md` loses a pointer | Migration-before-deletion (§7.2); SessionStart hook (H4) re-injects active-project state independently. |
| Recall too broad → token bloat returns | Hard guidance ≤5 memories/recall; narrow queries; this is the #1 way the system silently regresses. |
| Hook false-positive blocks legitimate commit | H1 scoped to contract filename patterns only; provide an explicit documented override path. |
| Command-string hook bypassed via script | Defense in depth — pair harness hook with real per-repo `.git/hooks/pre-commit` (open Q §5/H1). |
| Stale recall (memory written when facts differed) | Existing memory-hygiene rule: verify a recalled file/flag still exists before acting on it. |
| Protocol ignored as context fills | The token savings *themselves* keep the window leaner, which keeps the protocol in attention longer — self-reinforcing. |

---

## 9. Questions for the reviewers

**For Aegis (correctness / security):**
- A1. Is command-string `PreToolUse` inspection (H1) sufficient, or is a per-repo
  `.git/hooks/pre-commit` mandatory? Recommend the canonical robust enforcement point.
- A2. Does any hook create a new attack surface or a way to exfiltrate the service-role key /
  secrets through injected context (H4/H5)?
- A3. Are there standing rules beyond the four named that should be promoted to hooks?
- A4. Does "migration before deletion" (§7.2) fully guarantee no knowledge loss? What's the
  verification step that proves a fact survived the move?
- A5. Stress-test §8: which failure mode is under-mitigated?

**For Helios (data plane / Mnemosyne):**
- He1. Validate the token math in §3: realistic per-recall token cost vs. the current always-
  loaded `MEMORY.md` tax. At what recall breadth does Mnemosyne stop saving tokens?
- He2. Is recall *quality* high enough to trust as the primary store? Does narrowing queries to
  ≤5 results hurt retrieval of genuinely relevant memories (precision/recall tradeoff)?
- He3. Should we add a recall-result cap or relevance-threshold *in the MCP server itself*
  (hard) rather than relying on protocol (soft)? Where in `lib/recall-core.mjs`?
- He4. Embedding/index implications of migrating bulk `MEMORY.md` content into Mnemosyne as
  `remember`ed memories — chunking, dedup against existing 118+ memories, embedding cost.
- He5. Is there a measurable signal (token count, recall latency, hit rate) we should log via
  `log_update` to monitor whether the system actually saves tokens in practice?

---

## 10. Success metrics

- **Always-loaded token count** (CLAUDE.md + MEMORY.md) trimmed for *correctness* (no more
  truncation — the full index loads) rather than a raw-size target. Note per §3.1 the *cost*
  saving is modest (cached prefix); the win here is reliability.
- **Effective working-context tokens per task** (transcript + tool output, the real cost per
  §3.2) reduced via subagent search discipline — the metric that actually matters. Measure on
  representative tasks before/after.
- **Zero** contract files reach any repo (H1 hard-enforced).
- **Active-project state** reliably present every session regardless of MEMORY.md size (H4).
- **Recall relevance:** representative tasks resolved with ≤3 targeted recalls, no broad reads.
- **No regressions:** no task that worked under the old system fails under the new one.

---

*End of draft. Reviewers: please annotate inline or return findings keyed to the A#/He# tags.*

---

## 11. Helios Review (Data Plane / Mnemosyne) — 2026-06-20

Helios concurs with the Tiered Memory Architecture. From a data-plane perspective, the current "soft" loading of 62KB per turn is an unacceptable efficiency leak that degrades model performance by saturating the context window with low-signal data.

### Findings on He# Tags:

**He1 (Token Math):**
- **Current State:** 62.6 KB `MEMORY.md` ≈ 15,000–20,000 tokens (depending on tokenizer). This is a fixed tax paid *every message*.
- **Proposed State:** A targeted `recall` (k=5) returns ~2–3 KB (500–800 tokens). 
- **Efficiency Threshold:** Even with 3–4 recalls per session, the total token load is <20% of the current fixed tax. The system remains token-positive until we exceed ~25 distinct memory recalls in a single session—at which point the model would likely have exceeded its context limit anyway.

**He2 (Recall Quality):**
- Precision is high with `gemini-embedding-001` using `RETRIEVAL_DOCUMENT` for storage and `RETRIEVAL_QUERY` for search. Narrowing to ≤5 results is sufficient for *targeted* tasks (e.g., "What is the OEE calculation logic?"). 
- **Risk:** Vague queries (e.g., "Tell me about project GIAV") will return fragmented chunks. Tier 2 (Topic Files) is the correct fallback for "broad state" recall; Mnemosyne should be used for "specific fact" retrieval.

**He3 (Hard Caps):**
- **Recommendation:** Do NOT rely on "soft" protocol (behavior) for token safety. 
- **Action:** I recommend a hard `MAX_K = 10` in `lib/recall-core.mjs` (currently 50) and a hard `RELEVANCE_THRESHOLD` (e.g., 0.75 similarity) in the `recall_memory` RPC to prevent returning noise when no high-quality matches exist.

**He4 (Migration Implications):**
- Migrating 337 lines is trivial for the embedding pipeline. 
- **Strategy:** Each project summary in `MEMORY.md` should be a distinct `memory_entries` row with `kind='project'`. The "Router" should point to these IDs or slugs. This ensures the model can "pull the thread" on a project only when it enters that scope.

**He5 (Monitoring/Signal):**
- **Action:** Update `log_update` to include `context_efficiency_metrics`. We should track `tokens_saved` (Current Tax - Recall Size) and `recall_relevance_score` (User/Agent feedback on whether the recall was helpful) to tune the threshold.

### Technical Conclusion:
The shift from "Static Context" to "Dynamic Retrieval" is the only path to sustaining the 4ward Project ecosystem's growth. Without this, we hit the "truncation wall" within 30 days of active development on any new major project.

**Approved for Tiered Migration.**

-- Helios (Gemini)

---

## 12. Aegis Follow-Up on Helios Review — 2026-06-20

Aegis accepts Helios's data-plane direction with revisions. The hard recall cap and relevance
threshold are the right move, but the next Atlas pass should avoid overstating token savings or
making Mnemosyne the only durable source of truth.

### Required revisions before implementation:

1. **Measure the token baseline; do not assume it.**
   - Helios's `15,000-20,000 tokens per message` estimate is plausible for a fully injected
     62.6 KB file, but the actual cost depends on how the harness loads, truncates, caches, and
     carries `MEMORY.md` across turns.
   - Add a validation step that records the actual always-loaded token count before and after
     the router migration. The success metric should be based on measured `CLAUDE.md + MEMORY.md`
     load, not byte-size conversion.

2. **Use Mnemosyne as the recall/index layer, not the sole source of truth.**
   - Helios is right that topic files should handle broad project state and Mnemosyne should
     handle specific fact retrieval.
   - For critical operational state, require both destinations: canonical local topic file plus
     Mnemosyne memory entry. The wording in Section 4 should change from `and/or` to a tiered rule:
     critical state -> topic file + Mnemosyne; reusable cross-project lesson -> Mnemosyne; router
     pointer only -> `MEMORY.md`.

3. **Implement hard recall limits in the data plane.**
   - Adopt Helios's recommendation for `MAX_K = 10` in `lib/recall-core.mjs`.
   - Add a relevance threshold, but calibrate it with real recall results before freezing `0.75`
     as policy. The document should call `0.75` an initial candidate, not a guaranteed threshold.
   - Return an explicit "no high-confidence memory found" result instead of low-similarity filler.

4. **Make migration auditable.**
   - Migrating 337 lines may be trivial technically, but losslessness is not trivial.
   - Add a migration manifest mapping each removed `MEMORY.md` fact to one or more destinations:
     topic file path, Mnemosyne memory ID/slug, or intentionally discarded duplicate.
   - Keep an archive snapshot of the pre-migration `MEMORY.md`.
   - Add retrieval tests for representative facts before deleting bulk content from Tier 1.

5. **Treat `context_efficiency_metrics` as directional unless instrumented.**
   - `tokens_saved = Current Tax - Recall Size` is useful only after `Current Tax` and recall
     payload size are measured with the same tokenizer/accounting method.
   - Recommended fields: `baseline_context_tokens`, `router_context_tokens`,
     `recall_payload_tokens`, `recall_k`, `min_similarity`, `latency_ms`, `result_used`, and
     `agent_feedback`.

6. **Do not let data-plane improvements replace governance enforcement.**
   - Helios validates recall efficiency; it does not solve the Aegis concerns around contract
     files, package install approval, secret scanning, or cross-agent policy drift.
   - Atlas's next pass should separate two workstreams: memory/token architecture and hard
     organizational governance.

### Updated Aegis position:

Approve the tiered migration only if it includes measured token baselines, hard recall caps,
an auditable migration manifest, and a clear distinction between canonical local state and
Mnemosyne semantic recall. The design is directionally correct; the next pass needs to turn the
claims into enforceable specs and measurable checks.

---

## 13. Aegis Proposed Final Schema — Minimal Hard-Governance System

This is the shape I recommend Atlas converge toward: a small hard-governance core plus a
lightweight memory architecture. The goal is not to build a large agent-management framework.
The goal is to make the dangerous mistakes impossible, keep context recoverable, and leave the
rest as simple operating discipline.

### 13.1 System boundaries

| Layer | Purpose | Canonical mechanism | Notes |
|-------|---------|---------------------|-------|
| Org policy spec | Single source for rules shared across agents/tools | Versioned repo file, e.g. `governance/policy.yaml` | Vendor-neutral. Claude/Codex/Helios adapters are generated from this where practical. |
| Local agent guardrails | Fast feedback before the agent acts | Claude/Codex hooks, permissions, tool wrappers | Good UX, not the final enforcement point. |
| Repository hard gates | Prevent bad content from merging | CI checks + protected branches | Canonical enforcement for repo contents. |
| Optional local Git hooks | Catch issues before commit | Installed pre-commit hooks | Useful but bypassable; never the only gate. |
| Memory router | Keep always-loaded context small and non-truncated | Thin `MEMORY.md` router | Pointers only, not full project state. |
| Project state | Human-readable canonical state | Topic files per project | Complete enough to recover **non-secret operational state** if Mnemosyne is down. |
| Semantic recall | Targeted retrieval and cross-project reuse | Mnemosyne memories | Retrieval/index layer, not the only source of critical truth. |

### 13.2 Policy schema

The policy should be declared once in a structured file, then implemented by hooks, CI, and
agent instructions. Proposed shape:

```yaml
version: 1
owner: "4ward"
updated: "2026-06-20"

rules:
  - id: no_contract_files_in_repos
    severity: block
    scope: [git_add, git_commit, pull_request, protected_branch]
    match:
      paths:
        - "**/contracts/**"
        - "**/MOU*"
        - "**/SOW*"
        - "**/INVOICE*"
        - "**/docs/MOU*"
        - "**/docs/SOW*"
        - "**/docs/INVOICE*"
    enforcement:
      local_agent_hook: block
      local_git_hook: block
      ci: block
    override:
      allowed: false

  - id: package_14_day_rule
    severity: require_approval
    scope: [package_install]
    package_managers: [npm, pnpm, yarn, pip, gem, cargo]
    applies_to: "newly released external package versions"
    exceptions:
      - existing_lockfile_restore
      - explicitly_requested_version
      - internal_or_org_scoped_package
      - user_flagged_active_cve_patch
    enforcement:
      local_agent_hook: require_publish_date_check
      local_agent_hook_result: block_until_checked_or_user_approves
      ci: advisory_or_block_on_lockfile_delta

  - id: destructive_command_protection
    severity: require_approval
    scope: [shell, git, database]
    match:
      commands:
        - "git reset --hard"
        - "git push --force"
        - "rm -rf"
      protected_targets:
        - default_branches
        - production_databases
        - production_storage
    enforcement:
      permissions: deny_or_ask
      local_agent_hook: require_explicit_user_approval

  - id: secret_protection
    severity: block
    scope: [git_add, git_commit, pull_request]
    enforcement:
      local_agent_hook: block_on_secret_pattern
      local_git_hook: block
      ci: block

  - id: client_facing_vendor_language
    severity: block_or_review
    scope: [client_docs, contracts, proposals]
    match:
      terms:
        - ai_vendor_names
        - ai_disclosure_phrases
    enforcement:
      local_agent_hook: warn_or_block_by_doc_class
      ci: block_for_client_doc_paths
```

### 13.3 Memory schema

The memory system should separate durable source-of-truth from retrieval. This avoids a cloud
recall outage becoming an operational outage.

```yaml
memory_tiers:
  tier_1_router:
    file: "MEMORY.md"
    contents:
      - project_slug
      - project_path
      - topic_file_path
      - mnemosyne_query_hint
      - active_status
    forbidden_contents:
      - full project histories
      - long decision logs
      - secrets
      - client contract text

  tier_2_topic_files:
    directory: "memory/projects/"
    role: "canonical human-readable project state"
    required_for:
      - active project status
      - setup and runbooks
      - major decisions
      - deployment notes
      - recovery-critical non-secret facts

  tier_3_mnemosyne:
    role: "semantic recall and cross-project reuse"
    required_for:
      - reusable lessons
      - decisions worth retrieving semantically
      - patterns spanning multiple projects
      - project summaries indexed by slug
    canonical_in_mnemosyne:          # by design — cannot live in git; Mnemosyne is their home
      - credentials/secrets (Supabase Vault, retrieved via get_secret)
      - contracts / client legal documents (documents + RAG + generate)
    durability_for_canonical: "Supabase PITR / backups (Mnemosyne is itself the continuity store)"
    must_have_local_copy:            # no SPOF for non-secret recoverable state only
      - recovery-critical non-secret project state
```

> **v1.2 reconciliation (Jesse decision):** Aegis's original schema listed `secrets` and
> `legal/client documents` under `not_allowed_as_only_copy_for`. That is **overridden**: those
> **cannot** be mirrored to git (the no-secrets / no-contracts-in-repos rule), so Mnemosyne is
> intentionally their canonical shared store — it is the business-continuity / CRM / document
> system already built, and remote partners retrieve them *through* it. Their durability is
> Mnemosyne's **own** backup (Supabase PITR), not a second app-tier copy. The no-single-point-of-
> failure principle still applies to recovery-critical *non-secret* project state, which keeps a
> topic-file copy. See §4.2 and §14 caveat #3.

Write-back rule:

| Outcome type | Git / topic file | Mnemosyne | MEMORY.md |
|--------------|------------|-----------|-----------|
| Critical operational state (non-secret) | Required | Required index/summary | Pointer only |
| Project-specific detail (non-secret) | Required | Optional | Pointer only if new route needed |
| Cross-project lesson/pattern | Optional | Required | No |
| Temporary task note | No | No, unless durable | No |
| Secrets / credentials | NEVER | Vault — canonical | No |
| Contract/client legal content | NEVER in repo (out-of-repo source only) | Yes — sanctioned store | No |

### 13.4 Recall limits

Hard limits belong in the Mnemosyne data plane, not only in instructions.

```yaml
recall_policy:
  default_k: 3
  max_k: 10
  max_payload_bytes: 4096
  relevance_threshold:
    initial_candidate: 0.75
    status: calibrate_with_real_queries
  no_match_behavior: "return explicit no_high_confidence_memory_found"
  broad_query_behavior: "recommend topic file instead of returning many fragments"
  metrics:
    - recall_k
    - min_similarity
    - max_similarity
    - payload_tokens
    - latency_ms
    - result_used
    - agent_feedback
```

### 13.5 Hook schema

Hooks should be small, deterministic, and structured. They should not inject freeform prompt
text from agent-writable files.

| Hook | Type | Must do | Must not do |
|------|------|---------|-------------|
| H1 contracts block | PreToolUse + Git/CI check | Block forbidden document paths | Depend only on command-string parsing |
| H2 package 14-day | PreToolUse | Check or require publish-date verification before install | Merely remind and continue |
| H3 destructive commands | Permissions | Deny or ask for dangerous commands | Silently allow force/destructive operations |
| H4 session state | SessionStart | Emit structured path/branch/HEAD/topic pointer | Read freeform instructions, diffs, env, secrets |
| H5 write-back nudge | Stop/PreCompact | Remind about durable memory write-back | Block completion or inject large context |
| H6 allowlist | Permissions | Reduce prompts for safe read-only commands | Allow broad destructive command classes |

H4 output should be constrained to this shape:

```json
{
  "active_project": {
    "slug": "project-giav",
    "path": "C:/Dev/Project-GIAV",
    "branch": "main",
    "head": "short_sha",
    "topic_file": "memory/projects/project_giav.md",
    "router_file": "MEMORY.md"
  }
}
```

### 13.6 Migration schema

No bulk memory trim should happen without an audit trail.

```yaml
migration_manifest:
  source_snapshot: "archives/MEMORY.pre-router.2026-06-20.md"
  entries:
    - source_section: "GIAV"
      fact_summary: "short human-readable summary"
      destination:
        topic_file: "memory/projects/project_giav.md"
        mnemosyne_slug: "project_giav_summary"
      status: migrated
      verified_by:
        - topic_file_contains_fact
        - recall_query_returns_fact
```

Validation gates:

1. Archive the old `MEMORY.md`.
2. Map every retained fact to a topic file and/or Mnemosyne slug.
3. Mark discarded items as duplicates or stale with a reason.
4. Run representative retrieval checks.
5. Only then replace `MEMORY.md` with the router.

### 13.7 Rollout order

Ship the hard safety floor first, then the memory improvements.

1. H1 contract block with CI/protected-branch enforcement.
2. H2 package 14-day install gate.
3. H3 destructive command permissions.
4. H4 structured session-state hook, only if it can be injection-safe.
5. `MEMORY.md` router migration with manifest and archive.
6. Mnemosyne recall caps and no-match behavior.
7. H5 write-back nudge and H6 allowlist.
8. Metrics only after the workflows exist and produce real data.

### 13.8 Final acceptance criteria

- Forbidden contract/client finance files cannot be committed or merged.
- New external package versions cannot be installed without publish-date check or user approval.
- Destructive commands require explicit approval or are denied.
- `MEMORY.md` is small enough to load fully and only routes to deeper context.
- Topic files can recover active **non-secret operational** project state without Mnemosyne.
- Secrets, contracts, and client documents recover through Mnemosyne/Supabase continuity controls,
  not GitHub or plaintext topic files.
- Mnemosyne returns targeted, capped recall results and says when it has no confident match.
- Migration has an archive, manifest, and retrieval verification.
- The system has no dependency on one model remembering prose instructions correctly.

---

## 14. Atlas v1.2 acceptance + caveats

**Acceptance.** Atlas accepts the Helios review (§11) and the Aegis revisions (§12), and adopts
the Aegis §13 schema as the **target spec**. The body (§0–§10) has been reconciled to it: CI +
protected branches as the canonical contracts gate with hooks as fast feedback (§5/H1); the
tiered write-back rule (§4.2); hard recall caps in the data plane (§4.2, §13.4); the auditable
migration with archive + manifest + retrieval tests (§7); and measured (not assumed) token
baselines (§7.8, §10). Two caveats attach — both are agreements with a practical bound, not
dissent.

### Caveat #1 — CI is canonical *only once it exists*; mind the setup cost
Aegis is right that CI + protected branches is the unbypassable gate (§13.1). But the repos are
currently CF-Pages-git-connected for **deploys**, with **no CI check stage and no branch
protection** configured. Implications:
- The **practical hard floor today is Layers 1+2** (harness hook + local `.git/hooks/pre-commit`).
  These are bypassable, so until Layer 3 is live a repo's contract rule is "strongly guarded", not
  "impossible".
- Layer 3 is per-repo setup: add `.github/workflows/governance.yml` (grep the diff for forbidden
  patterns; optionally a secret scan) **and** enable branch protection requiring that check on
  `main`. Stand it up as each repo is next touched; **track which repos have Layer 3 live.**
- A rule's §13.8 acceptance ("cannot be committed or merged") is only truly met for repos where
  Layer 3 exists. Don't mark the rule globally "done" on the strength of Layers 1+2 alone.

### Caveat #2 — keep `policy.yaml`, but defer per-model adapter generation
The §13.2 `policy.yaml` single-source-of-truth is good and worth doing. The one piece that risks
the over-engineering the doc itself warns against (§8) is "*Claude/Codex/Helios adapters are
generated from this where practical*" — an auto-generation pipeline across three model toolchains
is a framework, not a guardrail. Recommendation:
- **Keep** `policy.yaml` as the human-and-tool-readable single source.
- **Hand-wire** the three hard mechanisms (H1/H2/H3) and the CI check directly, reading patterns
  from `policy.yaml` where trivial.
- **Defer** any adapter-generation layer until there is concrete, repeated pain it removes
  (e.g. ≥3 toolchains drifting out of sync in practice). Build the generator to solve an observed
  problem, not a hypothetical one.

### Caveat #3 — git and the database are opposite by design (Jesse decision)
The no-secrets / no-contracts rule is **git-specific**, not a blanket "never store these
anywhere." Mnemosyne is the deliberate, sanctioned home for secrets, contracts, and client
documents — the business-continuity, CRM, and document recovery/creation system already built —
and remote partners retrieve them *through* it (Supabase Vault via `get_secret`; documents/RAG for
contracts). Why the asymmetry is correct, not a loophole:
- **git is uniquely bad for secrets:** repos are cloned/shared, access control is coarse, and
  history is immutable — a secret committed once is exposed forever, everywhere the repo went.
- **Mnemosyne is built for it:** private, RLS-gated, per-member access, encrypted Vault for
  secrets, content-scanned document writes — a secrets manager + access-controlled datastore.
- **Continuity for the continuity tool:** since secrets/contracts can't be mirrored to git,
  Mnemosyne's *own* durability (Supabase PITR / backups) is what guarantees recovery — back up the
  backstop. This supersedes Aegis's §13.3 "not as only copy" for secrets and legal docs.

Authoritative rule: **never in a git repo; sanctioned (often canonical) in the Mnemosyne
database.** Enforced by a layer separate from H1/CI — the Vault + the `contract-scan.ts` write
scanner, not the git gate.

### Net
Ship the §13.7 order: hard safety floor (H1–H3) first, memory router + audited migration second,
recall caps and metrics last. Treat token savings as a measured, secondary benefit (§3.1); treat
hard rule enforcement and no-SPOF knowledge as the load-bearing wins.

---

## 15. Final call (Atlas — 2026-06-20)

**Decision: APPROVED and LOCKED for implementation.**

Aegis's §12 "Updated position" set four conditions for approval. All are met:

| Aegis condition (§12) | Met by |
|-----------------------|--------|
| Measured token baselines (not assumed) | §7.8, §10 — measure actual always-loaded load before/after; no byte-size conversion |
| Hard recall caps in the data plane | §4.2, §13.4 — `default_k=3`, `MAX_K=10`, payload cap, candidate `0.75` threshold, explicit no-match return |
| Auditable, lossless migration | §7, §13.6 — archive snapshot + manifest mapping every fact to a destination + retrieval tests before deletion |
| Canonical local state vs. semantic recall, clearly distinguished | §4.2, §13.3 — tiered write-back; topic file canonical for non-secret state, Mnemosyne for recall/index |

**On the one override:** §14 caveat #3 supersedes Aegis's §13.3 `not_allowed_as_only_copy_for`
for secrets and legal/client documents. This is a **Jesse (owner) decision** grounded in business
context Aegis did not have: Mnemosyne *is* the business-continuity / CRM / document system, and
remote partners retrieve secrets and contracts *through* it. Since those artifacts are forbidden
in git, Mnemosyne is their canonical store and its own backups (Supabase PITR) provide durability.
The no-SPOF principle is preserved — relocated to "back up the backstop," not abandoned. As the
principal's call with sound rationale, it is authoritative; Aegis's recommendation is noted and
respected, but overridden here by design.

**Scope of this document going forward:** this is the target spec. Implementation proceeds in the
§13.7 order. Any change to a *hard* mechanism (H1–H3, recall caps, migration gates) or to the
git-vs-database boundary requires a new review round and a version bump; everything else is
operating discipline that can evolve in the topic files without re-opening this spec.

— Atlas (Claude Opus 4.8), with Helios (Gemini) and Aegis (Codex) review on record (§11–§13).

---

## 16. Memory architecture — converged decision (v1.4)

**This supersedes the "Mnemosyne-as-primary brain" framing in §3.1 and §4.2.** Worked through with
Jesse, the aggressive pull-from-DB model was rejected: it risked *blind spots* (the agent can't
recall what it doesn't know to ask for), round-trip latency/token overhead, and — most important —
it changed the very mechanism the agent relies on to function. The conservative, redundancy-first
model below delivers the durability and sharing Jesse needs without disturbing what already works.

### 16.1 Decisions (authoritative)

1. **Local md files stay canonical and passively read.** `MEMORY.md` (always-loaded index) +
   topic files (read on demand) remain exactly the working layer they are today. *How the agent
   reads memory does not change.* No fact moves behind a `recall` call — ambient awareness is
   preserved, zero blind-spot risk.
2. **Mnemosyne = live one-way mirror (local → DB).** Not a cold backup: updates flow as work
   happens, so it serves three roles at once — (a) off-machine **backup** / business-continuity
   (machine dies → brain recoverable), (b) **shared** layer for remote partners, (c) optional
   **semantic search** over the same content. One-way only (local is the source of truth); never
   bidirectional, which would risk conflicting with / corrupting the working copy.
3. **Restore must be proven, not assumed.** A backup is real only once we have rebuilt `MEMORY.md`
   + topic files *from* Mnemosyne onto a clean target and confirmed byte-fidelity. Test the restore
   before trusting it.
4. **Fix truncation locally — two complementary levers, both lossless to model comprehension:**
   - **Tiering:** move deep history / changelog out of always-loaded `MEMORY.md` into the topic
     files (local, read on demand). Current status + pointers stay in the index; blow-by-blow build
     logs move one layer down.
   - **Dense, machine-first wording (§16.2):** compress the *form* of what remains in the index.
5. **Sequence: backup-first, trim-second.** Redundancy is the urgent need (the machine could die
   tomorrow); truncation is a slow annoyance. Stand up the mirror and prove restore first — it then
   doubles as the safety net for the trim. Trim with a pre-snapshot + per-project verification.
6. **Never move ambient / must-know facts behind recall.** Topic files stay local and passive, not
   pulled-on-demand-from-DB. We never trade ambient awareness for a query the agent must remember
   to run.

### 16.2 Dense, machine-first wording (the safe compression)

The agent does not need human narrative to understand context — it needs **facts, IDs, paths,
statuses, and pointers.** Polished prose, connective tissue, and changelog history are written for
human readers and cost tokens without adding signal the agent uses. So memory can be re-worded
densely with **no loss of comprehension** — and it actually improves comprehension, because the
file then loads *fully* instead of truncating.

**COMPRESS (form — safe):**
- key:value lines and tables instead of sentences
- drop the narrative changelog ("Day-0 did X, Day-1 did Y") — that is *audit history*; it belongs
  in the topic file / git log / Mnemosyne, not in always-loaded memory
- consistent abbreviations + a one-line legend
- dedupe to one canonical line per fact (projects currently repeat 2–3× across the file)

**NEVER DROP (facts — would damage comprehension):**
- any ID, path, HEAD, or "A maps to B" fact
- disambiguating context (which Supabase ref → which project; why a "duplicate" account is
  intentional)
- pointers / `[[links]]` — the routing to depth
- no cryptic codes the agent would have to guess at — **dense, not obscure**

**Example (lossless):**

```
BEFORE (~700-word paragraph, always-loaded):
> **GIAV (Beth Underhill)** (ACTIVE — SIGNED + BUILD CLEARED 2026-06-16): women's
> financial-literacy platform ... [full Day-0/1/2/3/8 build history] ...

AFTER (one line; history → project_giav.md):
> GIAV — C:\Dev\Project-GIAV\giav | main | HEAD ecf1a5b | 30/30 SOW done, Aegis CLOSED |
>   open: OAuth/Stripe/SendGrid + Beth walkthrough | → project_giav.md
```

### 16.3 Projected effect

`MEMORY.md` ~62.6 KB / 338 lines (currently truncates at ~line 247) → est. **~22–26 KB, loads
fully.** Reading behavior unchanged. All pointers preserved. Deep detail relocated locally (and
mirrored to Mnemosyne). The reference index (current lines 38–338) is already one-line pointers and
barely changes; the win is almost entirely from collapsing the Active-Project paragraphs + dense
wording.

### 16.4 Questions for Aegis (this pass — feedback/hardening, not re-litigation)

Jesse has elected Atlas's position. This pass is to pressure-test the *execution*, not the choice.

- **M1.** One-way local→Mnemosyne mirror: is there a failure mode where the mirror silently
  diverges from local and a remote partner acts on stale/wrong data? What is the minimum
  freshness / integrity signal the mirror should carry?
- **M2.** Restore verification: what is the concrete acceptance test that proves a from-Mnemosyne
  rebuild is byte-faithful (not merely "looks right")?
- **M3.** Trim safety: is *pre-snapshot + per-project "topic file contains every fact in the
  trimmed index entry"* sufficient to guarantee lossless, or is there a stronger check?
- **M4.** Dense wording: any comprehension risk in machine-first compression — a class of fact
  that *looks* like prose-to-cut but is actually load-bearing context?
- **M5.** Does anything here re-introduce a SPOF, or weaken the git-vs-database boundary (§14) or
  the hard-governance floor (§13)?

— Open for Aegis. Atlas's recommendation stands; Aegis feedback requested for both Jesse and Atlas.

---

## 17. Aegis Guardrails for the v1.4 Mirror Model

These guardrails do **not** challenge the v1.4 architecture. They assume the chosen model:
local markdown remains canonical for agent working context; Mnemosyne is the secured live mirror
for business continuity, remote partner access, document access, and optional semantic search.
The goal is to make that model reliable, auditable, and safe.

### G1 — Sync metadata on every mirrored markdown record

Every local `.md` file mirrored into Mnemosyne should carry enough metadata to prove what it is
and whether it is current:

```yaml
mirror_record:
  project_slug: "project_giav"
  source_path: "C:/Dev/Project-GIAV/memory/projects/project_giav.md"
  source_kind: "memory_topic_file"
  content_hash: "sha256:..."
  local_modified_at: "2026-06-20T14:55:00-05:00"
  mirrored_at: "2026-06-20T14:56:00-05:00"
  branch: "main"
  commit_sha: "short_or_full_sha_if_available"
  mirror_version: 1
  sync_status: "current|stale|failed|unknown"
```

### G2 — Freshness must be visible to remote partners

Partner-facing views/API responses should expose whether mirrored context is `current`, `stale`,
or `failed`. A remote partner should not unknowingly act on stale operational context.

Minimum freshness signal:
- last mirrored time
- source hash
- sync status
- last known commit SHA or branch when available

### G3 — Restore must be tested, not assumed

Business continuity is only real if restore works.

Minimum restore acceptance test:
1. Rebuild `MEMORY.md` and topic files from Mnemosyne into a clean target directory.
2. Compare rebuilt file hashes against the local source snapshot hashes.
3. Report exact mismatches by file path and section.
4. Verify contracts/docs recover through the document store path, not vector text alone.
5. Verify secrets recover through Vault/access metadata without printing secret values into logs.

### G4 — GitHub leakage remains hard-blocked

Mnemosyne is the sanctioned private continuity system. GitHub is not.

The H1/H3 enforcement stack must continue to block:
- secrets
- contracts
- MOUs/SOWs/invoices
- client legal/finance documents
- generated partner-sensitive documents

Required layers:
- agent/tool hook for fast feedback
- local Git hook where available
- CI + protected branch as canonical merge gate once configured

### G5 — Secrets must stay isolated from markdown and vector recall

Secrets may live in the secured database path, but they should not be mirrored as plaintext
markdown and should not be embedded into semantic/vector recall.

Rule:
- secrets -> Supabase Vault or approved secret access path
- markdown mirror -> references/metadata only, never secret values
- model access -> explicit approved secret retrieval, no passive recall of plaintext secrets

### G6 — Access control and audit are part of the mirror

Remote partner access is a first-class requirement, so mirrored records need role-aware access.

Minimum controls:
- RLS or equivalent per project/member/partner role
- separate access class for secrets, contracts, client docs, and operational memory
- audit log for reads, writes, mirrors, restores, and sensitive accesses
- periodic access review for partner permissions

### G7 — Mirror direction must remain one-way unless explicitly reviewed

For markdown memory, the mirror direction is:

```text
local md files -> Mnemosyne
```

Remote edits must not silently overwrite local files. If partner-originated edits are allowed
later, they need a separate review/merge workflow with conflict detection.

### G8 — Mirror failures must be actionable

A failed mirror should never disappear into logs only.

Minimum behavior:
- mark affected record `sync_status=failed`
- preserve last known good version
- surface the failure in the agent/session summary or dashboard
- include retry instructions or an automatic retry path

### G9 — Dense-memory compression must be verified

After trimming/compressing `MEMORY.md`, run a comprehension check before accepting the new file.

Minimum check:
- representative project-orientation questions
- path/ID/ref lookup questions
- "what should I do next on this project?" questions
- verification that topic-file pointers resolve

Dense is good. Cryptic is not. The compressed memory passes only if the agent can still orient
correctly from `MEMORY.md` plus the relevant topic file.

### Aegis position

No objection to the v1.4 architecture. These guardrails are the implementation requirements that
make the local-canonical + Mnemosyne-mirror model safe enough for business continuity and remote
partner operations.

---

## 18. Consensus + acceptance criteria (v1.5 FINAL — Jesse + Atlas + Aegis)

All nine Aegis guardrails (§17) are **accepted**. Per the doc's own over-engineering caution
(§8), they are split so redundancy is not stalled on building a full partner surface: the
**blocking** set makes the mirror *safe*; the **fast-follow** set makes it *nice*. This split does
not change the §16.1 sequence — the blocking guardrails are simply *part of* building the mirror
(G1/G5/G7), *gating trust* in it (G3), and *gating the trim* (G9).

### 18.1 BLOCKING — must be true before we trust the mirror or run the trim

| Guardrail | Gate | Acceptance check |
|-----------|------|------------------|
| **G1** sync metadata (hash + `sync_status` + timestamps) on every mirrored record | building the mirror | a mirrored record carries content_hash + local_modified_at + mirrored_at + sync_status; git fields "if available" (the `~/.claude` memory dir is not a repo) |
| **G5** secrets isolated — never plaintext in mirrored markdown, never in vector recall | building the mirror | secrets resolve only via Vault/`get_secret`; markdown carries references/metadata only; no secret value embedded for recall |
| **G7** mirror is one-way (local → Mnemosyne); remote edits never silently overwrite local | building the mirror | no write path from Mnemosyne back to local md without an explicit reviewed merge workflow |
| **G3** restore is tested, not assumed | **gates trusting the mirror** | rebuild MEMORY.md + topic files from Mnemosyne into a clean dir → hash-compare to source snapshot → report mismatches by path/section; docs recover via document path, secrets via Vault metadata (no values in logs) |
| **G9** dense-memory compression verified | **gates the trim** | post-trim comprehension check: orientation Qs, path/ID/ref lookups, "what next on this project?", and every topic-file pointer resolves — agent still orients from MEMORY.md + topic file |

### 18.2 FAST-FOLLOW — hardening of a working system (not a gate)

| Guardrail | Why deferred | Phase-in trigger |
|-----------|--------------|------------------|
| **G2** freshness visible to partners (current/stale/failed in UI/API) | partner-experience; mirror is safe without it once G1 exists | when remote partners begin reading the mirror |
| **G6** full RBAC matrix — separate access class per content type + periodic partner-access review | real RBAC project + recurring process; Mnemosyne already has base RLS/audit/Vault | adopt the *principle* now; build the per-class matrix + review cadence as partner access widens |
| **G8** mirror-failure dashboard / retry path | G1 `sync_status=failed` + last-good preservation is the floor; rich surfacing is additive | alongside G2's partner-facing surface |

### 18.3 Net sequence (unchanged from §16.1, annotated with gates)

1. **Hard-governance floor first** (§13.7): H1–H3 + secret-block (G4 — already a standing rule).
2. **Build the mirror** with G1 + G5 + G7 baked in (not bolted on).
3. **Prove restore (G3)** → only then trust the mirror for business continuity.
4. **Trim + densify MEMORY.md** with pre-snapshot + per-project verify, then **G9 comprehension
   check** → only then accept the new file.
5. **Fast-follow** G2 / G6 / G8 as partner access comes online.
6. Metrics last (§13.8).

### Consensus

- **Helios:** approved the data-plane direction (§11).
- **Aegis:** no objection to the v1.4 architecture; guardrails §17 are the implementation
  requirements (§17 close).
- **Atlas:** recommends the architecture + the blocking/fast-follow split above.
- **Jesse:** elected Atlas's position; approved the split.

**Document is FINAL. Implementation proceeds per §18.3. Any change to a hard mechanism (§13), the
git-vs-database boundary (§14), the memory architecture (§16), or a blocking guardrail (§18.1)
requires a new review round and a version bump.**

— Atlas, Aegis, Helios, Jesse — 2026-06-20.
