# 0033 — P2-LOOP v1: prospect-research loop + case-study doc type (design)

- **Opened:** 2026-07-03 (Atlas/Fable)
- **Status:** ✅ **DESIGN APPROVED (Aegis re-review, at bottom) — HANDED TO SONNET 5 FOR
  IMPLEMENTATION, with ONE BINDING CORRECTION:** `select for update` on the computed name only
  serializes the UPDATE path — on FIRST CREATE there is no row to lock, so two concurrent writers
  race to the unique-name constraint. Sonnet MUST serialize before the existence check (Aegis offers
  two acceptable shapes: transaction-scoped advisory lock keyed on the name/client id — house
  precedent exists, the p4w ingest advisory-lock key — or an atomic `insert ... on conflict` design
  that still snapshots the prior row to `memory_versions` exactly once on the update branch) AND add
  a concurrent-first-create test: two simultaneous writes → one row, no unhandled 23505, coherent
  final body, documented audit/version behavior. Second build note also binding: `source_path=null`
  is a NEW client_brief-owned provenance shape (remember uses `mcp/<slug>`) — generic
  `remember_memory` and file-backed `ingest_memory_entry` must not own/update these entries.
  History: r1 = NOT APPROVED (2 blockers) → r2 resolved both → approved. Migration `0030` stays
  UNAPPLIED until Aegis post-build QC + Jesse apply-go.
- **Unit:** roadmap thread `0024` recommended-sequence step 5 ("first item that plausibly *makes*
  money"). Folds in the **`case-study` doc type** (Jesse's 2026-06-29 open item #1 — it IS the
  collateral this loop produces). P2-DRAFT (outreach email drafting) is DEFERRED except where noted.
- **Working model:** Atlas plans (this doc) → Aegis QC → Sonnet 5 implements (migration held
  UNAPPLIED) → apply-go → post-apply gate → smoke → Aegis live sign-off.
- **Migration number:** `0030_loop_doc_types.sql` (0027–0029 applied). Deliberately TINY — this unit
  is mostly code + one runbook; the loop's heavy machinery (bridge, client_360, hybrid recall, CRM
  fields, doc factory, hosted MCP) shipped in 0027/0032.
- **Verified facts (2026-07-03, r2-corrected per Aegis):** `doc_kind` enum is additively extendable
  (0022 precedent); `DOC_TYPE_CATALOG` in `functions/_lib/brand-template.ts` mirrors
  `src/lib/docTypes.ts` — **9 entries** (r1 said 12: a bad grep, Aegis correction accepted), with
  `category` typed `contract | marketing` ONLY (no internal — hence r2 Part B); hosted MCP exposes
  recall/fetch/log_update/brief only — `remember`/`update` structurally absent (0027 §5: "deferred
  to a 2b unit pending need" — **this unit is the documented need**, scoped far narrower).

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

## Part A — migration `0030_loop_docs_and_brief_rpc.sql` (held UNAPPLIED)

1. `alter type public.doc_kind add value if not exists 'case-study';`
   `alter type public.doc_kind add value if not exists 'client-brief';` (additive, 0022 pattern).
2. `save_rendered_document`'s doc_type allow-list gains both (locate the actual validation — Sonnet:
   read 0022's RPC, don't assume where the list lives).
3. **(r2, resolves Aegis blocker 1) NEW dedicated RPC `upsert_client_brief`** — the write-path
   contract, exact. None of the three existing write RPCs fits (Aegis is right: `remember_memory`
   has no bridge params; `ingest_memory_entry` is the FILE-backed path — requires a `memory/*.md`
   source_path/slug a machine-authored brief doesn't have, and carries no actor/audit/versioning;
   `update_memory` never creates and demands `expected_updated_at`). One narrow definer RPC keeps
   every guarantee in one atomic place:
   - **Signature:** `upsert_client_brief(p_actor uuid, p_client_id uuid, p_deal_id uuid,
     p_title text, p_body text, p_embedding vector(768), p_embedding_model text)` → jsonb
     `{name, refreshed, version_no}`. Service-role-only execute, `security definer`, empty
     search_path, fully qualified — house pattern verbatim.
   - **Name strategy (deterministic, collision-proof, ≤80):**
     `'client-brief-' || left(<slugified client name>, 50) || '-' || left(p_client_id::text, 8)`
     — worst case 13+50+1+8 = 72 chars; the id suffix disambiguates similarly named clients.
   - **Algorithm (atomic):** validate actor (active team_members row) + client exists + optional
     deal belongs to that client; compute name; `select ... for update` on that name —
     **EXISTS** → snapshot to `memory_versions` (next version_no, `edited_by = p_actor`,
     `change_reason = 'prospect-research refresh'`) then UPDATE body/title/embedding + client_id/
     deal_id + `updated_at = now()`; **NOT EXISTS** → INSERT with `kind='reference'`,
     `source_path = null` (operator/mcp provenance, exactly like remember's entries), links set at
     birth. Returns `refreshed` so the tool can report create-vs-update.
   - **Concurrency: deliberately SERIALIZED, not optimistic.** The `for update` row lock is the
     contract — this name family has exactly one writer shape (the tool), briefs are last-write-wins
     research artifacts, and forcing machines through an expected_updated_at read-then-write dance
     buys nothing here. Documented as a deliberate divergence from update_memory's model.
   - **Audit:** the RPC itself calls `log_activity(p_actor, 'agent.client_brief', 'clients',
     p_client_id, {memory_name, title, refreshed, deal_id})` — one write path, one audit path.
   - Validation caps in-RPC: title ≤200, body ≤24,000, embedding 768-dim unit-norm (remember's
     checks, reused shape).
4. Post-apply gate: enum values present; RPC execute denied anon/authenticated, granted
   service_role; allow-list accepts new types + still rejects unknown.

## Part B — doc-type catalog + structural audience model (r2, resolves Aegis blocker 2)

**The audience model, exact (Aegis-preferred shape):** the catalog spec in BOTH mirrors gains
`allowedAudiences: ('client' | 'internal')[]`. Every EXISTING type gets `['client','internal']` —
byte-identical behavior to today. `category` stays `contract | marketing` (it drives the SCAN
policy split and is orthogonal to audience permission — do not overload it with a third value).
**Server-side enforcement FIRST:** `render-document` and `save-rendered-document` reject
`audience` ∉ `allowedAudiences[docType]` with a structural 400 BEFORE the governance scan/render —
cheap-validation-first order (0024 P2-ORDER rule), and the check lives server-side so a hand-crafted
request fails identically to the UI. The Create tab derives its audience toggle from
`allowedAudiences` (hidden when only one) — UI is a convenience, never the boundary.

`functions/_lib/brand-template.ts` + `src/lib/docTypes.ts`:
- **`case-study`** — category `marketing`, `allowedAudiences: ['client','internal']` (same policy
  split as white-paper/use-case). Starter scaffold: Client & Context / Challenge / What We Built /
  Outcome (metrics) / Pull Quote / About 4ward. Until now a case study mapped to `use-case`;
  entries keep working, new ones get the real type.
- **`client-brief`** — category `marketing` (its scan policy when internal), but
  **`allowedAudiences: ['internal']` — the client audience is structurally impossible**, enforced
  server-side per above (a research brief names vendors and candor a client must never see).
  Scaffold: Company Snapshot / People / Signals-Why-Now / Fit vs 4ward Capabilities / Suggested
  Angle / Draft Outreach (clearly marked DRAFT — the P2-DRAFT sliver we DO take) / Sources.

## Part C — hosted MCP additions (the agent-enabling surface)

**C1. `client_brief` tool (scope `client_brief`) — the narrow write (r2: calls the Part-A RPC).**
- Args: `{ client: string (name OR uuid), title, body (markdown), deal?: string (title or uuid) }`.
- Tool-side pipeline, in order (0024 P2-ORDER: cheap first): validate args/caps (body ≤24,000,
  title ≤200) → **ingress secret-scan on title+body** (the SAME scanner remember's core uses —
  reuse, don't reimplement; research pastes are exactly where a stray key arrives) → resolve client
  (uuid accepted directly if it exists; else case-insensitive exact name, else unique substring,
  else structured candidates error — never guess, NEVER auto-create) → **(r2 clarification) resolve
  `deal` scoped to the resolved client**: uuid accepted if it belongs to that client; else
  exact-then-unique-substring on `deals.title` WHERE client_id matches; ambiguous → candidates
  error → rate check `mcp_client_brief` 6/hour → embed body (Gemini, endpoint-side) → ONE call to
  `upsert_client_brief` (all audit/link/version guarantees live in the RPC, Part A).
- Telemetry source='mcp'; activity `agent.client_brief` written BY the RPC (single audit path).
**C2. `client_360` tool (scope `client_360`) — the grounding read.** Thin wrapper over the existing
service-role RPC: `{ client: string }` → same resolution rules as C1 → **(r2 clarification) capped
STRUCTURALLY, never raw-JSON-truncated**: if the RPC result exceeds 16,000 chars, drop whole items
from the lowest-priority arm first (activity → documents → memories; client/contacts/deals never
dropped), setting per-arm `truncated: {activity: n_dropped, ...}` flags — agents always receive
parseable JSON and know exactly which arm was clipped.
- Both tools: schema-declared AND runtime-enforced caps (0027 lesson); scoped tools/list.
- **(r2 clarification) smoke battery, explicit:** tools/list for a token with the new scopes lists
  them; a recall-only token's tools/list does NOT contain client_brief/client_360; direct
  out-of-scope tools/call → 403; plus the standard 401 no-oracle set.
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
   (internal ONLY). **(r2) Structural proof server-side, not UI-side:** a hand-crafted
   `render-document` AND `save-rendered-document` request for `client-brief` with
   `audience:'client'` both fail with the structural 400 (before scan); existing 9 types behave
   byte-identically to today (regression spot-check via the render smoke staying 19/19).
3. `client_brief` tool: happy path writes the linked memory (client_id set, name forced
   `client-brief-<slug>-<id8>`, kind reference, source_path null) AND a re-run
   updates-not-duplicates with a `memory_versions` row (`edited_by` = machine actor,
   change_reason 'prospect-research refresh'); deal resolution scoped to the client (foreign deal
   uuid → error; ambiguous title → candidates); ambiguous client → candidates
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

---

## Aegis Design Review - 2026-07-02

**Verdict: NOT APPROVED AS-IS.** The unit is the right next move, but Sonnet should not build from this design until the two blocking contract gaps below are resolved. Both are design-level issues caused by current repo mechanics, not objections to the loop itself.

### Blocking Findings

1. **`client_brief` write path is under-specified and currently mixes incompatible write semantics.**
   - The design says the tool writes through the existing sanctioned ingest path, sets `client_id`/`deal_id`, and on re-run uses versioned `update_memory` semantics.
   - Current repo reality: `remember_memory` is actor-audited but does not accept `client_id`/`deal_id`; `ingest_memory_entry` can now set bridge links but has no actor parameter, no `log_activity`, and no `memory_versions` snapshot; `update_memory` is versioned but only updates an existing row and requires `expected_updated_at`.
   - Required revision: specify the exact create/update algorithm before build. Acceptable shapes include a dedicated narrow service-role RPC for `client_brief`, or an explicit two-path hosted implementation where create and update both preserve audit/link/version guarantees. The design must state how first create links the memory, how re-run produces a version row, how optimistic concurrency is handled or intentionally serialized, and how `agent.client_brief` activity is written.
   - Also bind the name strategy. `client-brief-<client-slug>` must respect the existing 80-character memory name limit and avoid collisions for similarly named clients. Use a deterministic suffix, preferably from client id, if needed.

2. **`client-brief` internal-only document posture is not implementable from the current catalog model as written.**
   - Current `DOC_TYPE_CATALOG` is 9 entries, not 12, and both server/client catalogs type `category` as only `contract | marketing`.
   - `render-document` and `save-rendered-document` currently default `audience` to `client`; `policyFor` only accepts `contract | marketing`. Simply adding `client-brief` with category `internal` will not compile without expanding the model, and adding it as marketing without stricter audience rules would permit client-facing render/save unless explicitly blocked.
   - Required revision: define the structural audience model. Preferred: add catalog-level `allowedAudiences` or equivalent, make `client-brief` internal-only in both mirrors, enforce it server-side before scan/render/save, and make the Create tab omit the client audience option for that doc type. Acceptance should prove `client-brief` with `audience:'client'` fails at both render and save, not just that the UI hides it.

### Non-Blocking Clarifications

- Correct the verified-facts line from 12 catalog types to the actual current count, 9, before adding the two new types.
- Define `deal?: string` resolution for `client_brief`: title scoped to the resolved client, id accepted, ambiguous candidates returned, no guessing.
- For `client_360` hosted MCP, specify the returned shape for the 16,000-character cap. Prefer structured section truncation flags over raw JSON truncation so agents know which arm was clipped.
- Extend smoke expectations to include tools/list scoping for the two new scopes, direct out-of-scope calls returning 403, and absence of `client_brief` from a recall-only token.

### Gate To Approval

Atlas should revise this design before Sonnet builds. Once the write-path contract and internal-only document model are explicit, this unit can proceed; the scope is otherwise appropriate and aligned with the roadmap.

### Atlas response — r2 revision (2026-07-03)

Both blockers accepted — both were repo-mechanics facts I got wrong or left implicit:

1. **Write path now a dedicated `upsert_client_brief` RPC** (Part A #3) with the complete algorithm:
   deterministic collision-proof name (`client-brief-<slug≤50>-<clientid8>`, ≤72 chars), atomic
   `for update` create-or-version-then-update, `memory_versions` snapshot with machine `edited_by`,
   in-RPC `agent.client_brief` audit (one write path = one audit path), and **concurrency
   deliberately serialized via the row lock rather than optimistic** — documented as an intentional
   divergence from `update_memory` (single writer shape, last-write-wins research artifact; an
   expected_updated_at dance buys machines nothing here). Aegis's observation that ingest is the
   file-backed path was the decisive fact — a machine brief has no source file, so `source_path =
   null` operator/mcp provenance, like remember's entries.
2. **Structural audience model:** catalog gains `allowedAudiences` in both mirrors; all 9 existing
   types `['client','internal']` (zero behavior change); `client-brief` `['internal']`; enforcement
   is a server-side structural 400 in BOTH render and save BEFORE the scan (P2-ORDER), with the UI
   toggle derived, never authoritative. `category` stays two-valued — it drives scan policy, and
   overloading it was the r1 mistake.
3. All four clarifications bound in place: facts line corrected to 9; deal resolution spec'd
   (client-scoped, uuid-or-title, candidates on ambiguity); `client_360` cap is structural per-arm
   item-dropping with counts, never raw truncation; the scope smoke battery is written out.

**→ Ready for Aegis re-review.**

---

## Aegis Design Re-Review - 2026-07-02

**Verdict: DESIGN APPROVED FOR SONNET 5 IMPLEMENTATION, with the binding correction below.** Atlas r2 resolves the two Aegis r1 blockers: the write path is now a dedicated `upsert_client_brief` RPC, and the document audience model now uses catalog-level `allowedAudiences` with server-side enforcement before scan/render/save.

### Resolved Blockers

1. **Write-path contract resolved.** A dedicated service-role-only `upsert_client_brief` RPC is the right shape for this unit. It avoids misusing `remember_memory`, `ingest_memory_entry`, or `update_memory`, and it centralizes link setting, version snapshotting, actor validation, and `agent.client_brief` audit in one database transaction.

2. **Internal-only document posture resolved.** Keeping `category` as `contract | marketing` while adding `allowedAudiences` is the correct model. `client-brief` can stay `marketing` for scan-policy purposes while being structurally internal-only through server-side audience validation. The acceptance criteria now correctly require hand-crafted `render-document` and `save-rendered-document` requests with `audience:'client'` to fail before scan/render.

### Binding Implementation Correction

- The r2 wording says concurrency is serialized by `select ... for update` on the computed memory name. That only serializes the update path when the row already exists. On first create, there is no row to lock, so two concurrent writers can both observe `NOT EXISTS`; one insert will win and the other will hit the unique `memory_entries.name` constraint unless Sonnet adds an explicit first-create serialization mechanism.
- Required implementation: serialize before the existence check, for example with a transaction-scoped advisory lock keyed on the computed memory name/client id, or use an atomic `insert ... on conflict` design that still guarantees the update branch snapshots the prior row to `memory_versions` exactly once. Do not rely on `select for update` alone for first create.
- Add a smoke or targeted RPC test for concurrent first-create behavior: two simultaneous `client_brief` writes for the same client must produce one memory row, no unhandled unique-constraint error, a coherent final body, and the expected audit/version behavior documented by the chosen algorithm.

### Additional Build Notes

- `source_path = null` is schema-valid, but it is not "exactly like remember's entries"; `remember_memory` uses `mcp/<slug>`. Treat this as a new `client_brief`-owned provenance shape and keep both generic `remember_memory` and file-backed `ingest_memory_entry` from owning/updating it.
- Post-build Aegis will block if `upsert_client_brief` is public/anon/authenticated executable, lacks empty `search_path`, omits fully qualified identifiers, skips actor validation, writes audit outside the transaction, or fails to prove `client-brief` internal-only enforcement at both render and save endpoints.

### Handoff

Sonnet may implement against r2 with the correction above. Migration `0030_loop_docs_and_brief_rpc.sql` remains held unapplied until Aegis post-build QC and Jesse apply-go.
