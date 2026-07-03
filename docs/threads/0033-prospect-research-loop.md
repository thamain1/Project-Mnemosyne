# 0033 — P2-LOOP v1: prospect-research loop + case-study doc type (design)

- **Opened:** 2026-07-03 (Atlas/Fable)
- **Status:** DESIGN — awaiting Aegis review, then Sonnet 5 builds. No build work authorized yet.
- **Unit:** roadmap thread `0024` recommended-sequence step 5 ("first item that plausibly *makes*
  money"). Folds in the **`case-study` doc type** (Jesse's 2026-06-29 open item #1 — it IS the
  collateral this loop produces). P2-DRAFT (outreach email drafting) is DEFERRED except where noted.
- **Working model:** Atlas plans (this doc) → Aegis QC → Sonnet 5 implements (migration held
  UNAPPLIED) → apply-go → post-apply gate → smoke → Aegis live sign-off.
- **Migration number:** `0030_loop_doc_types.sql` (0027–0029 applied). Deliberately TINY — this unit
  is mostly code + one runbook; the loop's heavy machinery (bridge, client_360, hybrid recall, CRM
  fields, doc factory, hosted MCP) shipped in 0027/0032.
- **Verified facts (2026-07-03):** `doc_kind` enum is additively extendable (0022 precedent);
  `DOC_TYPE_CATALOG` in `functions/_lib/brand-template.ts` mirrors `src/lib/docTypes.ts` (12 types);
  hosted MCP exposes recall/fetch/log_update/brief only — `remember`/`update` structurally absent
  (0027 §5: "deferred to a 2b unit pending need" — **this unit is the documented need**, scoped far
  narrower than full remember).

## Why (one paragraph)

Everything the loop needs now exists, but no agent can actually RUN it end-to-end: there is no way
for a machine to write its research into the brain linked to a client (hosted surface is read+append
only), no `client-brief`/`case-study` document types to shape the output, and no codified procedure
— so prospect research stays ad-hoc chat work that evaporates. This unit adds the three missing
pieces: a narrow client-linked write tool, the two doc types, and the committed runbook that turns
"research this lead" into a repeatable one-line dispatch producing durable, CRM-linked assets.

## The loop (v1 shape — human-in-the-loop where it counts)

```
Jesse (or a stale-deal digest line): "research <lead>" → agent session (operator or machine via hosted MCP)
  1. GROUND   — client_360 (if client exists) + hybrid recall (client/kind filters) + brief
  2. RESEARCH — agent-side web research (Claude's own tools; Mnemosyne is not a crawler)
  3. PERSIST  — client_brief tool → kind='reference' memory, name 'client-brief-<slug>',
                client_id linked (bridge) → visible in client_360/graph immediately
  4. DRAFT    — agent drafts capabilities-brief / case-study MARKDOWN grounded on (1)+(3)
  5. HANDOFF  — human renders/saves via Create tab (case-study type) + attaches to deal;
                outreach stays DRAFT-ONLY text in the brief (P2-DRAFT posture: never send)
```

Steps 2 and 4 are agent-side (that's what the agent IS); Mnemosyne's job is grounding (1), durable
linked persistence (3), and branded output (5). v1 keeps render/save/attach human-gated — an agent
publishing collateral unreviewed is exactly the "auto-final" failure the factory's design forbids.

## Part A — migration `0030_loop_doc_types.sql` (held UNAPPLIED)

1. `alter type public.doc_kind add value if not exists 'case-study';`
   `alter type public.doc_kind add value if not exists 'client-brief';` (additive, 0022 pattern).
2. `save_rendered_document`'s doc_type allow-list gains both (locate the actual validation — Sonnet:
   read 0022's RPC, don't assume where the list lives).
3. Nothing else. No new tables, no new grants beyond what the RPC edit implies.

## Part B — doc-type catalog (code, both mirrors)

`functions/_lib/brand-template.ts` + `src/lib/docTypes.ts`:
- **`case-study`** — category `marketing` (client+internal audience toggle, same policy split as
  white-paper/use-case). Starter scaffold: Client & Context / Challenge / What We Built / Outcome
  (metrics) / Pull Quote / About 4ward. Until now a case study mapped to `use-case`; entries keep
  working, new ones get the real type.
- **`client-brief`** — category `internal` (NEVER client-facing; internal policy allows vendor
  names, which a research brief needs). Scaffold: Company Snapshot / People / Signals-Why-Now /
  Fit vs 4ward Capabilities / Suggested Angle / Draft Outreach (clearly marked DRAFT — the P2-DRAFT
  sliver we DO take) / Sources.

## Part C — hosted MCP additions (the agent-enabling surface)

**C1. `client_brief` tool (scope `client_brief`) — the narrow write.** NOT generic remember:
- Args: `{ client: string (name, resolved case-insensitively — ambiguous/missing → structured
  candidates error, never guess, never auto-create), title, body (markdown), deal?: string }`.
- Writes via the existing sanctioned ingest path with: `kind='reference'`, name FORCED to
  `client-brief-<client-slug>` (one canonical brief per client — re-run = versioned update via
  update_memory semantics, change_reason auto-set 'prospect-research refresh'), `client_id` (and
  `deal_id` if resolved) linked — the ONLY machine path that may set bridge links, per 0032's
  deliberate deferral.
- **Ingress secret-scan runs on the body** (same scanner as remember's path — reuse, don't
  reimplement) — research pastes are exactly where a stray copied API key would arrive.
- Caps: body ≤ 24,000 chars; title ≤ 200. Rate bucket `mcp_client_brief` 6/hour (research cadence,
  not chat cadence). Telemetry source='mcp' as established.
- Machine action allowlist: the tool logs `agent.client_brief` activity (allowed prefix, entity =
  client) — audit shows WHICH machine researched WHOM.
**C2. `client_360` tool (scope `client_360`) — the grounding read.** Thin wrapper over the existing
service-role RPC: `{ client: string }` → same resolution rules → the RPC's JSON, hard-capped at
16,000 chars with honest per-section truncation flags (brief's pattern). Memories/documents stay
metadata-only (RPC already guarantees).
- Both tools: schema-declared AND runtime-enforced caps (0027 lesson); scoped tools/list; 401/403
  batteries extended.
- exec-pro gets both scopes on apply-go (provision script `--scopes` update documented).

## Part D — the runbook (the loop itself, per the handoff SOP)

`docs/runbooks/prospect-research.md` — the committed procedure an agent session executes from one
line ("Read <path>; research <lead>"): grounding calls → research checklist (company, people,
signals, tech surface) → REQUIRED source citations in the brief body → client_brief call →
draft-collateral instructions (case-study/capabilities framing, grounded on client_360 + recall
hits) → handoff line to Jesse (what to render, what deal to attach). Includes the hard rules:
no outreach sending EVER (draft text only), no client auto-creation (missing client → report back,
human creates via CRM tab), secret-scan is not optional.

## Non-goals (v1)

- Sending anything (email/LinkedIn) — drafting only, forever until a dedicated deliverability unit.
- Agent-side render/save/attach — human-gated in Create tab (auto-final is forbidden).
- Generic machine `remember`/`update` — only the client_brief shape ships.
- Lead sourcing/scraping infrastructure — the agent's own research tools are the crawler.
- Backfilling old use-case docs to case-study.

## Acceptance criteria (the gate)

1. Migration applies clean; both enum values present; `save_rendered_document` accepts both types
   and still rejects unknown types; post-apply gate proves no grant drift.
2. Create tab renders + saves a `case-study` (client + internal audience) and a `client-brief`
   (internal ONLY — client audience must be structurally absent for it, not just 422).
3. `client_brief` tool: happy path writes the linked memory (client_id set, name forced, kind
   reference) AND a re-run updates-not-duplicates with a version row; ambiguous client → candidates
   error; unknown client → error, NO auto-create; body with a planted secret → refused by ingress
   scan; over-cap body → structured error; out-of-scope token → 403 + absent from tools/list.
4. `client_360` tool: resolves, returns capped JSON w/ truncation flags on an oversized fixture;
   scope battery as above.
5. The written brief is immediately visible in: `client_360` (memories arm), hybrid recall with
   `client_id` filter, and the graph (bridge edge renders).
6. Runbook dry-run: a real agent session executes `docs/runbooks/prospect-research.md` against a
   FIXTURE client end-to-end (research steps stubbed with provided text) producing the linked brief
   + a draft case-study markdown — the e2e proof, analogous to 0027's criterion 10.
7. `npm run build` green (functions typecheck incl.); all existing smokes stay green (bridge 68/68,
   hosted 65/65 + new checks, render 19/19, telemetry 14/14, log-update 15/15).
8. Migration held UNAPPLIED until Aegis post-build QC + Jesse apply-go; deploy order: apply (enum +
   allow-list are backward-compatible — old code never sends the new values) → push. State it in
   build notes anyway.

## Rollback

Enum values are permanent in PG (documented, harmless — unused values). Allow-list edit, tools,
catalog entries, runbook = code; rollback = revert commits. No data destruction anywhere.
