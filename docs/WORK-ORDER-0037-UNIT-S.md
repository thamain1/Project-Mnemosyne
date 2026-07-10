# WORK ORDER — 0037 Unit S: SEC hardening (migration `0033`)

- **Design:** `docs/threads/0037-system-improvement-sprint.md` § Unit S — READ IT FIRST.
- **Roles (this unit, per Jesse 2026-07-10):** **Aegis BUILDS** this WO. **Atlas/Fable QCs** (design
  author QC — flagged deliberately; Aegis gets adversarial-review credit on the design itself: if a
  spec line below is wrong against the live code, STOP and record the discrepancy in the thread doc
  rather than building through it).
- **Discipline:** migration `0033` written but **HELD UNAPPLIED** until QC + Jesse apply-go. Never
  push code to `main` (auto-deploys) that hard-depends on the unapplied migration — S2/S3 caller
  code pushes AFTER apply (0032 precedent). Commit work; **do not push until the apply-go step
  says to.** Log every commit to the brain (`log_update` `work.commit`).
- **Verified ground truth (2026-07-10, re-checked against HEAD `7fe088a`):**
  - `functions/api/agent-context.ts:58-64` — the tenant filter is app-code-only:
    `.contains('tags', ['client:'+clientSlug]).overlaps('tags', wantedTags)` on `memory_entries`.
  - `supabase/migrations/0029_recall_hybrid_similarity_cast.sql` = the **authoritative current**
    `recall_memory_hybrid` definition (0027 → 0028 `#variable_conflict` → 0029 `::double precision`).
    Its `similarity` OUT column is actually `rrf * recency` (~0.01–0.03), sorted on, and the true
    per-arm cosine (`vscore`) is computed in `vec_best` but discarded.
  - Callers of the hybrid RPC: `mcp/lib/recall-core.mjs:125` ONLY (serves both local MCP and hosted
    `functions/api/mcp.ts`, which imports the core). Display at `recall-core.mjs:95`:
    `[${Number(r.similarity).toFixed(3)}]`. Keyless tests: `mcp/test-recall.mjs`. Live smoke:
    `scripts/smoke-bridge-crm-hybrid.mjs:320-341`.
  - ⚠️ `functions/api/recall.ts:115` (dashboard search) still calls OLD pure-vector `recall_memory`
    — **OUT OF SCOPE here** (Unit R "old-recall retirement"). Do not touch it; do not break it.

---

## S1 — Rotate the service-role key (JESSE, ops — not an agent task)

Standing owed item (0024 §P4; `mcp.ts` header marks it a deploy-gate). Procedure = the proven 0027
one: generate new `sb_secret` in Supabase dashboard → pipe straight into CF Pages secret
(`SUPABASE_SERVICE_ROLE_KEY` on project-mnemosyne — never on disk, never in a transcript) → patch
local `.env.local` + `mcp/.env.local` → redeploy → disable the old key → re-run the full smoke set
(hosted MCP 98-check suite, agent API 30-check, telemetry, render). **Unit S cannot be signed off
until S1 is done.** Aegis: verify completion by confirming the OLD key gets 401 against PostgREST
and all smokes are green on the new one — do not handle the new key value.

## S2 — DB-level tenant backstop for agent-context reads (migration `0033` part 1 + caller switch)

**Why:** the write side has a DB invariant (`0031:163` — `record_agent_outcome` asserts
`client:<slug>` ∈ tags). The read side is one app-level PostgREST filter guarding what
`agent-context.ts:12-14` itself calls the one unforgivable bug. Mirror the invariant.

**Migration `0033` (part 1):** new function, house pattern verbatim (`security definer`,
`set search_path = ''`, fully-qualified, service-role-only execute, revoke from
public/anon/authenticated):

```sql
create or replace function public.get_agent_client_context(
  p_client_slug text,
  p_wanted_tags text[],
  p_limit int default 20
)
returns table (body text, tags text[], updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select e.body, e.tags, e.updated_at
  from public.memory_entries e
  where e.tags @> array['client:' || p_client_slug]          -- THE BACKSTOP: tenant scope in SQL
    and e.tags && p_wanted_tags
  order by e.updated_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 20)
$$;
```

Binding details:
- **Validate inputs in-function** (raise on: null/empty `p_client_slug`; `p_client_slug` not matching
  `^[a-z0-9][a-z0-9-]*$`; `p_wanted_tags` null/empty or > 21 elements — 1 customer + `MAX_TECH_IDS=20`).
  A definer RPC must not trust its caller's parsing.
- Optionally (Aegis judgment): assert `p_client_slug` exists in `public.agent_clients` and is active
  — cheap, makes the RPC useless for probing arbitrary tag namespaces.
- If Unit L has not landed (it hasn't): NO `archived` filter yet — do not reference columns that
  don't exist.

**Caller switch (`functions/api/agent-context.ts`, pushed only AFTER apply):** replace the
`.contains().overlaps()` query (lines 58-64) with
`admin.rpc('get_agent_client_context', { p_client_slug: clientSlug, p_wanted_tags: wantedTags, p_limit: MAX_ROWS })`.
**Keep the response-shape identical** (customer-facts-first ordering at lines 69-71 operates on the
returned rows exactly as before — the RPC returns the same three fields the code already uses).
Everything else in the file (strict args, auth, rate limit, `waitUntil` telemetry) is untouched.

**Smokes:** extend `scripts/smoke-agent-api.mjs` with: (a) direct-RPC cross-tenant negative — call
`get_agent_client_context` with client A's slug and tags that only exist under client B → 0 rows;
(b) both-directions endpoint negative re-run (the 0031 suite already has the shape); (c) RPC execute
denied to anon/authenticated (expect `42501`, proven via a real anon-key call — house rule: prove the
deny, don't assume it).

## S3 — Honest recall scores (migration `0033` part 2 + caller switch)

**Why:** `recall-core.mjs:95` prints the RRF×recency fusion score (~0.01–0.03) labeled as
similarity — every agent reading `[0.033]` under-trusts a top-ranked result. Split the fields.

**Migration `0033` (part 2):** the return shape changes, so `create or replace` will fail with
`42P13` — you MUST `drop function if exists public.recall_memory_hybrid(text, public.vector, int,
text, uuid, uuid, uuid);` then `create` fresh, **in the same migration/transaction**. New definition
= byte-for-byte the 0029 body (KEEP `#variable_conflict use_column`, KEEP the `::double precision`
cast lesson, KEEP `OPERATOR(public.<=>)`, KEEP the scoped-filter CTE) with exactly these deltas:

1. `returns table (name text, title text, kind public.memory_kind, source_path text,
   score double precision, similarity double precision, updated_at timestamptz, matched_via text)`
   — `score` = the fused `rrf * recency-boost` expression (the sort key, cast as 0029 does);
   `similarity` = the best vector arm's true cosine (`vec_best.vscore`), **NULL for fts-only rows**.
2. Carry `vscore` through the `fused` CTE (it's already computed in `vec_best`; the `full outer join`
   just needs to select `v.vscore`) and cast it `::double precision` in the final select — same
   NUMERIC/DOUBLE trap 0029 fixed; do not reintroduce it on the new column.
3. `order by score desc` (ranking behavior IDENTICAL to today — only the output labeling changes).
4. Re-issue the revoke/grant block for the (unchanged) argument signature — the DROP destroyed the
   old ACLs.

**Deploy-window note (fail-open check, deliberate):** between apply and the caller push, deployed
`recall-core.mjs:95` reads `r.similarity` → it will briefly display true cosine (better than today)
and `0.000` for fts-only rows (`Number(null)`). Harmless and short; sequence apply → immediate code
push anyway.

**Caller switch (`mcp/lib/recall-core.mjs` + its `.d.mts` if the type is declared):** format line
becomes both-fields, e.g. `[score 0.031 · sim 0.87]` with `sim n/a` when null. Update
`mcp/test-recall.mjs` fixtures (rows gain `score`, `similarity` nullable) and the hosted
`functions/api/mcp.ts` recall tool description if it names fields. `npm run build` must pass
(functions typecheck is wired in — that's the 0026 lesson).

**Smokes:** extend `scripts/smoke-bridge-crm-hybrid.mjs`: rows expose BOTH columns; an fts-only match
(`UNIQUE_TOKEN` + random embedding, the suite's existing trick at `:320`) has `similarity IS NULL`
and `matched_via='fts'`; a vector match's `similarity` ∈ (0,1] and ≈ a hand-computed
`1 - (embedding <=> query)` for a known row; ordering unchanged vs a pre-migration capture of the
same query (ranking must NOT shift — only labels).

---

## Order of execution

1. Build S2 + S3: migration file `supabase/migrations/0033_sec_hardening.sql` (both parts, one file)
   + caller code + keyless tests + smoke extensions. Commit (no push). `npm run build` green,
   keyless test suites green.
2. **STOP → hand to Atlas/Fable QC** (code review against this WO + the 0037 design; QC record goes
   in the thread doc).
3. Jesse apply-go → apply `0033` via Management API → post-apply gate: RPC exists w/ correct ACLs
   (verify via `pg_proc.proacl`, not information_schema — house rule), cross-tenant negative at SQL
   layer, hybrid returns 8 columns.
4. Push caller code → CF auto-deploys → run FULL live smoke set (agent-api, bridge-crm-hybrid,
   hosted-mcp, log-update, render) — all green.
5. S1 confirmed done (Jesse) → Atlas/Fable final QC sign-off recorded in
   `docs/threads/0037-system-improvement-sprint.md` → MEMORY.md state bump on push.

## Acceptance (from the design doc, restated)

- Old service-role key returns 401; all smokes green on the rotated key.
- Cross-tenant read attempt returns empty **at the SQL layer** (proven by the direct-RPC negative,
  independent of the app filter).
- Recall output shows `score` + `similarity`; a hand-checked pure-vector query's `similarity`
  matches its cosine; fts-only rows show `similarity` null; ranking order unchanged.
- No regression: 30/30 agent-api, hybrid smoke suite, hosted-MCP suite, `npm run build`.
