# 0026 — INCIDENT: /api/generate-contract crashes in prod when instrumented (RESOLVED)

- **Opened:** 2026-07-02 (Sonnet 5, during thread 0025 P5-TELEMETRY build)
- **Status:** ✅ **RESOLVED 2026-07-02 (Fable), commit `7907c9b`** — root cause found by static
  review, fixed, re-instrumented, verified live (smoke 14/14). See "ROOT CAUSE + RESOLUTION" below.
- **Severity:** Was P0 (live sales-factory endpoint down); closed at P2 (endpoint had been restored
  by revert; now re-instrumented and fully working).

## ROOT CAUSE + RESOLUTION (2026-07-02, Fable)

**Root cause: the instrumented `generate-contract.ts` called `logUsage(...)` without importing it.**
Both crashing commits (`053f956` and `e76ce2d`) have exactly four imports — `@supabase/supabase-js`,
`contract-templates`, `contract-scan`, `rate-limit` — and **no `import { logUsage } from
'../_lib/usage'`**. All six working endpoints have that import (e.g. `ask-docs.ts:15`). One missing
line, endpoint-specific by construction.

Why every observed symptom follows:

- **Happy-path-only crash:** validation/auth failures return before the `logUsage` call site; only
  requests that reach the end of the handler evaluate the undefined identifier →
  `ReferenceError: logUsage is not defined` → uncaught → CF error 1101 ("Worker threw exception" —
  the code was telling the truth; it never was a platform limit).
- **`waitUntil` non-fix:** `context.waitUntil(logUsage(...))` evaluates the bare identifier
  `logUsage` *synchronously* to build the argument — the ReferenceError fires before `waitUntil`
  itself ever runs. Identical crash by necessity, not coincidence.
- **100% deterministic both directions:** presence/absence of the line, nothing environmental.
- **Why the build shipped it:** CF Pages bundles `functions/` with esbuild, which does NOT resolve
  bare identifiers — an undefined name is emitted as a global lookup that fails at runtime. And
  `npm run build`'s `tsc -b` covers only `src/` (tsconfig.app) + the vite config (tsconfig.node);
  **`functions/` was type-checked by nothing.** A syntax error would have failed the build; a missing
  import is invisible to it.
- (Unexplained but now moot: `wrangler pages deployment tail` captured nothing for the failing
  requests — Pages tail is evidently lossy for this error class. Do not rely on it to rule out
  application exceptions.)

**Fix (`7907c9b`):**
1. Re-applied the full 0025 instrumentation (usageMetadata capture + `context.waitUntil(logUsage(...))`)
   **with the import**.
2. **Prevention:** added `tsconfig.functions.json` (strict, noEmit, whole `functions/` tree) and wired
   it into `npm run build` (`tsc -b && tsc -p tsconfig.functions.json && vite build`). Proof it would
   have caught this P0 pre-push: the crashing version fails it with
   `error TS2304: Cannot find name 'logUsage'`; the current tree passes clean.

**Verification (live prod, post-deploy):** `scripts/smoke-usage-telemetry.mjs` **14/14** (was 12/14
with 2 known-fails) — generate-contract returns 200 with real markdown on the exact repro payload AND
writes a `usage_events` row with real provider tokens (`input_tokens=523, output_tokens=248,
model=gemini-2.5-flash, bytes_out=17597`).

**Post-mortem note for the working model:** Sonnet's investigation was rigorous (clean hypothesis
tests, full-deploy verification, honest revert) but the static review missed the import list — it
reviewed the *diff*, which doesn't show unchanged import lines, and reasoned "the same helper works in
6 endpoints" without diffing the import blocks across files. Lesson: when a symbol "works everywhere
except one file", diff the import blocks first — it's a 30-second check that beats any runtime
hypothesis. The lasting fix is structural (the typecheck), not procedural.

---

*Original investigation record below, kept as-was for archaeology.*

## TL;DR

Adding one `await`ed Supabase RPC call (`logUsage`, wrapping `admin.rpc('log_usage', {...})`) to the end
of `functions/api/generate-contract.ts` — a Cloudflare Pages Function — causes **every** request on the
endpoint's happy path to fail with a raw Cloudflare error page: **"Worker threw exception" (Cloudflare
error 1101)**, HTTP 500, empty/HTML body (not a JSON error from our own code). The identical change,
using the identical shared helper, deployed successfully to **6 other endpoints in the same codebase**
and works correctly in all of them, including one (`ask-docs.ts`) that has a very similar shape (also
calls Gemini `generateContent`, also parses `usageMetadata`, also calls the same `logUsage` helper).

Switching the call from `await logUsage(...)` to `context.waitUntil(logUsage(...))` (fire-and-forget,
removes any added response latency) did **NOT** fix it — identical crash, byte-for-byte same symptom,
after a full redeploy. This is important: it rules out the leading hypothesis (see below) and suggests
the cause is something else that is specific to `generate-contract.ts`'s code path, not merely "one more
awaited network call."

## Environment / how to reproduce

- **Live prod URL:** `https://project-mnemosyne.pages.dev/api/generate-contract`
- **Repo:** `C:\Dev\Project-Mnemosyne`, GitHub `thamain1/Project-Mnemosyne`, branch `main`
- **Cloudflare Pages project:** `project-mnemosyne`, account id `77c86d39bc8dbac1cdec9a260d1bbcab`
  (jmorgan@4wardmotions.com). `wrangler` is OAuth-authed locally:
  `npx wrangler pages deployment list --project-name project-mnemosyne`
- **Supabase project:** `qdugyduthemcrmtvgqek` (Mnemosyne). Management API / MCP `apply_migration`,
  `execute_sql` etc. all work against it directly.
- **Local env for smoke scripts:** `.env.local` at repo root has `VITE_SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY` — enough to create throwaway members and sign
  in for real JWTs. **It does NOT have `GEMINI_API_KEY`** — that secret is CF Pages server-side env only,
  not synced locally, which is why local `wrangler pages dev` reproduction wasn't possible (see below).

### Minimal repro (this exact payload crashed the instrumented deploy every time, deterministically)

```js
// throwaway member setup: admin.auth.admin.createUser + insert into team_members(active:true),
// then anon client signInWithPassword to get a real JWT. See scripts/smoke-usage-telemetry.mjs
// for the full boilerplate (setup()/signIn()/cleanup() functions) — reuse those verbatim.

POST /api/generate-contract
Authorization: Bearer <member JWT>
Content-Type: application/json

{
  "doc_type": "mou",
  "fields": {
    "project_name": "Debug Portal",
    "client_entity": "Acme Wellness LLC, a North Carolina limited liability company",
    "client_attn": "Dana Rivera",
    "client_signatory_name": "Dana Rivera",
    "engagement_ref": "DEBUG-001",
    "sow_ref": "DEBUG-SOW-001",
    "timeline": "eight (8) weeks",
    "milestones_table": "table",
    "fee_summary": "fee.",
    "purpose": "purpose.",
    "scope_summary": "scope.",
    "client_responsibilities": "resp."
  },
  "ground": false
}
```

**With the instrumented code deployed:** HTTP 500, body is Cloudflare's stock error page,
`<title>Worker threw exception | project-mnemosyne.pages.dev | Cloudflare</title>`, error code 1101,
`X-Ray` present. **With the reverted code deployed:** HTTP 200, real markdown JSON. This was retried
6+ times against 3 different deployments (initial instrumented, waitUntil variant, revert) — 100%
reproducible in both directions, not flaky.

A validation-failure request (missing required field, e.g. `{"doc_type":"sow","fields":{"project_name":"x"}}`)
returns a normal 400 JSON error even on the INSTRUMENTED deploy — so the crash only happens on the
**happy path that reaches Gemini generation and returns 200**, not on every request to the endpoint.

## The exact diff that caused it

Full instrumented version saved for reference: `git show 053f956:functions/api/generate-contract.ts`
(this thread's commit). Diff vs the last known-good version (`788200b`):

```diff
-async function generate(prompt: string, apiKey: string): Promise<string> {
+async function generate(prompt: string, apiKey: string): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }> {
   const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEN_MODEL}:generateContent`
   const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 45000)
   try {
     // ...unchanged fetch call...
     const data = await res.json()
     const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('').trim()
     if (!text) throw new Error('empty generation')
-    return text
+    const usage = data?.usageMetadata ?? {}
+    return { text, inputTokens: usage.promptTokenCount ?? null, outputTokens: usage.candidatesTokenCount ?? null }
   } finally { clearTimeout(timer) }
 }

+  let genInputTokens: number | null = null, genOutputTokens: number | null = null
   if (toDraft.length) {
     // ...unchanged prompt assembly...
     let genText: string
-    try { genText = await generate(parts.join('\n'), GEMINI) } catch { return json({ error: 'generation failed' }, 502) }
+    try {
+      const gen = await generate(parts.join('\n'), GEMINI)
+      genText = gen.text; genInputTokens = gen.inputTokens; genOutputTokens = gen.outputTokens
+    } catch { return json({ error: 'generation failed' }, 502) }
     // ...unchanged regex parsing loop...
   }

   // ...unchanged assembly/scan code (draft slots, fill slots, leftover-marker check, scanContract)...

+  await logUsage(admin, {          // later changed to context.waitUntil(logUsage(admin, {...})) — same crash
+    actorId: uid, tool: 'api/generate-contract', model: toDraft.length ? GEN_MODEL : null,
+    inputTokens: genInputTokens, outputTokens: genOutputTokens,
+    bytesIn: total, bytesOut: md.length,
+  })
   return json({ doc_type: docType, title: TITLES[docType], markdown: md, sources, warnings, scan_clean: scan.clean })
```

`logUsage` (`functions/_lib/usage.ts`) is a ~15-line helper: `await admin.rpc('log_usage', {...})`
wrapped in `try { } catch { /* swallow */ }`, i.e. it structurally cannot throw. `admin` is the same
`SupabaseClient` (service-role) already in scope and already used earlier in the same function for the
`team_members` lookup and the rate-limit RPC — both of which run successfully before the crash point.

**This same helper, called the same way, is deployed and working right now in:**
`functions/api/recall.ts`, `functions/api/search-docs.ts`, `functions/api/ask-docs.ts`,
`functions/api/render-document.ts`, `functions/api/save-document.ts`,
`functions/api/save-rendered-document.ts`. `ask-docs.ts` is the closest analog — it also calls Gemini
`generateContent`, also parses `data?.usageMetadata`, also calls Gemini `embedContent` first (for
retrieval), also calls `logUsage` at the very end before `return json(...)`. It works.

## What's different about generate-contract.ts vs the 6 working endpoints

None of these were conclusively implicated, but they're the candidate differences:

1. **Bigger prompt / longer generation.** `generate-contract` asks Gemini to draft up to 4 sections
   (`fee_summary`, `purpose`, `scope_summary`, `client_responsibilities`, `managed_service`,
   `future_phases` depending on doc_type) in one `generateContent` call with `maxOutputTokens: 8192`,
   vs `ask-docs`'s single Q&A answer capped at `maxOutputTokens: 1024`. Generation likely takes longer
   wall-clock.
2. **Optional grounding step.** When `ground: true` (default true; the repro above sets `false` to
   isolate this), it does an extra `embedQuery` call + `search_docs` RPC + a `documents` table fetch
   before generation. **Not implicated** — the repro crashes with `ground: false`, skipping this
   entirely.
3. **Bigger assembled output.** The final `md` string is a full contract (legal boilerplate + all
   fill/draft slots substituted) — likely several KB, vs `ask-docs`'s short answer string. `bytesOut:
   md.length` is passed to `logUsage` as a plain JS number; nothing exotic, but it's the largest
   `bytesOut` value of the 7 instrumented endpoints by a wide margin.
4. **Most sequential awaits in one request.** By the time `logUsage` fires, this request has already
   done: anon `auth.getUser` (1 network call) → `team_members` select (1) → `rate_take` RPC (1) →
   Gemini `generateContent` (1, slow) → then `logUsage`'s `admin.rpc('log_usage', ...)` (1 more). This
   is the most award-chained request of the 7 endpoints. The `waitUntil` test was meant to rule out
   "one more sequential await pushes wall-clock over some limit" — and it DID NOT fix the crash, which
   argues against pure request-duration/CPU-time being the cause, but doesn't fully rule out some other
   resource limit (e.g. total isolate memory across the whole request lifecycle, since `waitUntil` still
   runs the RPC using memory the isolate holds, just after the response is sent).

## Debugging already tried (in order, so it isn't repeated)

1. **`wrangler pages deployment tail <deployment-id> --project-name project-mnemosyne`** — required an
   explicit `--deployment-id`-equivalent positional arg in non-interactive mode (bare `tail` errors
   with "Must specify a deployment in non-interactive mode"). Connected successfully ("Connected to
   deployment ..., waiting for logs..."), confirmed connected before firing the request, then fired the
   exact repro request while the tail was live. **Zero log lines were captured for the failing
   request**, across 3 separate attempts with different deployment IDs. This strongly suggests CF error
   1101 in this case is a **platform-level isolate termination** (e.g. hard CPU-time/memory/wall-clock
   limit) that happens outside the normal Workers Functions request-log hook, not a catchable
   application-level exception — those normally DO show up in `wrangler tail` with a stack trace.
2. **Hypothesis: awaited RPC latency crosses a Cloudflare per-request time budget.** Generate-contract
   already runs a slow (up to 45s-capped) Gemini call; reasoned that awaiting one more network
   round-trip after it could tip the total request over a platform limit. **Fix attempted:** changed
   `await logUsage(...)` to `context.waitUntil(logUsage(...))` in all 7 endpoints (this is also just a
   better pattern regardless — fire-and-forget telemetry should never add response latency — so it was
   kept for the other 6 even after this hypothesis failed). Redeployed, re-ran the exact repro:
   **identical 500, same error 1101.** Hypothesis rejected. This was a real, clean test (full commit +
   push + confirmed-active deployment + re-run), not a guess left untested.
3. **Local reproduction attempted via `wrangler pages dev dist --port 8788`.** Server started
   successfully and bound Supabase env vars from `.env.local`, but **`GEMINI_API_KEY` is not present in
   `.env.local`** (it's CF Pages server-side env only) — so the happy path that triggers the crash
   (past the `if (!GEMINI) return json({error:'server misconfigured'},500)` guard) could not be
   exercised locally without either adding the real key to a local env file (a secrets-handling decision
   Fable/Jesse should make, not something done unilaterally) or mocking Gemini's endpoint.
4. **Static code review** of the exact diff (above) — found no logical bug: variable scoping is correct
   (`admin`, `uid`, `total` all in an enclosing scope reachable at the call site), no duplicate/stale
   function definitions, brace/paren balance is correct, TypeScript syntax is valid (verified by CF's
   own successful build+deploy — a syntax error would have failed the whole Pages build, and it didn't).
5. **Reverted `functions/api/generate-contract.ts` to the exact content of commit `788200b`** (the
   pre-incident version) via `git checkout 788200b -- functions/api/generate-contract.ts`, rebuilt
   (`npm run build` green), committed (`f6694a8`), pushed, redeployed, and confirmed restored: the exact
   repro payload returns 200 with real markdown again.

## Commits, in order (for git archaeology)

| Commit | What |
|---|---|
| `788200b` | Last known-good `generate-contract.ts` (pre-incident) |
| `053f956` | P5-TELEMETRY instrumentation added to all 7 endpoints + MCP + dashboard — **this is when the crash started** |
| `aedbd19` | Unrelated grant-fix migration (`usage_events` SELECT grant) + smoke script bugfixes — doesn't touch `generate-contract.ts` logic |
| `e76ce2d` | Switched `await logUsage` → `context.waitUntil(logUsage)` across all 7 endpoints — **did not fix the crash** |
| `f6694a8` | Reverted `generate-contract.ts` only, back to `788200b` content — **confirmed this fixed it** |
| `36a1d80` | Docs only (this incident recorded in `docs/threads/0025-usage-telemetry.md`) |
| `ce39558` | Docs only — this handoff writeup committed |
| `7907c9b` | **THE FIX** (Fable): re-instrumented WITH the missing `logUsage` import + `tsconfig.functions.json` typecheck wired into `npm run build`. Smoke 14/14 post-deploy. |
| `687dba7` | Docs close-out: this doc marked RESOLVED, thread `0025` closed at 7/7 |

`git diff 788200b e76ce2d -- functions/api/generate-contract.ts` shows the full crashing version
(instrumented + waitUntil). `git diff 788200b HEAD -- functions/api/generate-contract.ts` should be
empty (current state = reverted = last known good).

## Ideas not yet tried

- **Bisect the diff itself.** Redeploy with ONLY the `generate()` return-type change (capture
  `usageMetadata`, still `return text` unpacked at the call site, no `logUsage` call at all) to see if
  *that alone* crashes it — would isolate whether it's the extra Gemini response parsing or the
  `logUsage`/RPC call that's the actual trigger. Symmetric test: add back ONLY the `logUsage` call with
  the ORIGINAL `generate()` signature (drop the token capture), to isolate the other half.
- **Check the Cloudflare Pages dashboard's Functions/Real-time Logs UI directly** (not `wrangler tail`)
  for this deployment's failed requests — the dashboard sometimes surfaces CPU-time-exceeded /
  memory-exceeded errors that `wrangler tail` doesn't show in the CLI's default format.
- **Check whether this Pages project is on "Bundled" vs "Unbound" Workers usage model** — Bundled has a
  much stricter CPU time limit (10ms-50ms range historically, though CF has changed defaults over time)
  vs Unbound's much higher ceiling. If Pages Functions here are Bundled and `generate-contract` is
  already near that ceiling doing markdown assembly + regex over a multi-KB string + a scan pass, ANY
  additional CPU-bound work (not just I/O-bound await) could tip it over — this is a different resource
  axis than the "wall-clock during an await" hypothesis already rejected, and worth checking in the CF
  dashboard's project settings.
- **Get the real Gemini key into a local `.env.local` (or a temp `.dev.vars` for `wrangler pages dev`)**
  to reproduce locally with full request/response visibility, sidestepping prod entirely. This needs a
  deliberate secrets-handling decision (pull from the vault via `get_secret`, or have Jesse supply it
  directly) rather than being done as a side effect of debugging.
- **Try the request with a MUCH smaller `md.length` / fewer draft sections** (e.g. only 1 required
  draft field instead of 4-6) on a re-instrumented deploy, to see if the crash is proportional to
  output size — would support the CPU/memory-limit theory over a pure logic bug.

## Where things stand for whoever picks this up

- `functions/api/generate-contract.ts` is currently the pre-incident version — **no usage telemetry**,
  fully working, matches `788200b`.
- The other 6 endpoints + all 6 MCP tools + the dashboard Usage card are live, instrumented, and
  confirmed working (see `docs/threads/0025-usage-telemetry.md` and `scripts/smoke-usage-telemetry.mjs`,
  12/14 passing — the 2 known-fails are generate-contract's usage-row assertions, expected given the
  revert).
- Migrations `0024` (`usage_events` + `log_usage` RPC) and `0025` (grant fix) are both applied to prod
  and are NOT implicated in this incident (they're just the schema; the crash is in the Pages Function
  runtime, not the database — `log_usage` itself was proven callable via direct RPC in
  `scripts/smoke-usage-telemetry.mjs` checks 1c/1d).
- Once root-caused and fixed, re-instrumenting `generate-contract.ts` is the same 3-part pattern already
  applied to the other endpoints (see `functions/api/ask-docs.ts` for the closest reference
  implementation): capture `usageMetadata` in the Gemini call, thread the tokens through to the
  response-assembly point, `context.waitUntil(logUsage(admin, {...}))` right before the final
  `return json(...)`.
