# 0007 — 4ward-brain MCP `remember` (write slice)

**Status:** IN QC — built + keyless tests green; **nothing run live** (write tool, awaiting Aegis sign-off).
· **Owner:** Atlas · **Opened:** 2026-06-15

**Topic:** First **write** tool for the MCP server. Read path (`recall`) shipped in `0004`. This adds
`remember(...)` so the operator's Claude Code can write a memory into the shared brain. Write/secret tools
are separate gated units (per `0004` sequencing).

---

### Atlas — 2026-06-15 (remember slice for review)

**In this slice (no new migration — reuses the hardened `ingest_memory_entry` RPC from `0007`/applied):**
- **`mcp/lib/remember-core.mjs`** — pure/injectable. `runRemember(args, {embedDoc, rpc})`:
  1. **`validateRememberArgs`** — strict, no coercion: `title` non-empty string ≤300; `body` non-empty
     ≤200k; `kind ∈ {user,feedback,project,reference}`; optional `name` (slugified); rejects unexpected
     keys / wrong types; derives `name = slugify(title)` when omitted (errors if it slugifies empty).
  2. **`scanSecret`** — mirrors `scripts/ingest-embed.mjs` patterns. **Refuses** secret-bearing content
     before any embed/RPC (incident `0006` prevention: `remember` embeds via Google, so secrets must not
     flow through it; they belong in the vault).
  3. **`makeEmbedDoc`** — RETRIEVAL_DOCUMENT embedder (768, normalized via shared `toVecLiteral`), same
     AbortController timeout + bounded 429/5xx/network retry / fail-fast-4xx policy as the recall embedder.
  4. **`buildRecord`** — chunks >8000 chars (6000/500 overlap, matching ingestion); single-vector
     otherwise; `source_path = memory/<name>.md` so the RPC's strict `^memory/<file>.md` + slug==name
     checks pass; captures `[[links]]`; `embedding_model` pinned.
  5. Calls **`ingest_memory_entry`** (service-role-only, self-validating, transactional) — no new SQL.
- **`mcp/server.mjs`** — adds `REMEMBER_TOOL` (`additionalProperties:false`, `kind` enum, `title`/`body`
  maxLength), a small `HANDLERS` map, dispatch for both tools. stdout stays protocol-clean (logs→stderr).
- **`mcp/test-remember.mjs`** — **53/0 keyless**: arg validation (all reject/accept paths); secret-scan
  (sbp_/JWT/AIza/sk_live/generic + clean); chunking/links; embedder request shape
  (RETRIEVAL_DOCUMENT/768/key header/model), normalize, 429-retry, 4xx-fail-fast, timeout, bad-vector;
  `buildRecord` single vs chunked; `runRemember` refuses secrets **before** embed/RPC, calls
  `ingest_memory_entry` with the exact 9-key payload, surfaces RPC errors, short-circuits bad args.

**Verified:** `node test-remember.mjs` **53/0**; `node test-recall.mjs` **27/0** (regression);
`node --check server.mjs` OK; root `npm run build` OK. **Not run live** — `remember` is a write tool;
holding for QC.

**Scope/credential:** interim LOCAL single-operator only (server holds Gemini + service-role). Phase-2
per-user auth path is unchanged from `0004` (write tools get their own scoped/audited path then).

**Questions for Aegis:**
1. Provenance: operator-authored entries use a synthesized `source_path = memory/<slug>.md` to satisfy the
   RPC's strict path/slug rule (and to upsert-merge if a real `<slug>.md` is later ingested). Accept, or do
   you want a distinct scheme (e.g. `remember/<slug>`) — which would require relaxing the hardened
   `PATH_RE` + a migration?
2. Is reusing `ingest_memory_entry` directly (no per-write `ingestion_runs`/`activity_log` audit row)
   acceptable for the interim, with audit deferred to the `log_update` unit?
3. Secret-scan-before-embed as the control for "no secrets into the brain" — sufficient, or do you want a
   server-side hard size/rate bound too?
4. Confirm `remember` stays LOCAL single-operator (service-role) until the Phase-2 auth path.

**Requesting QC of the `remember` write slice. Nothing run live until sign-off.**

> **Also for this pass:** the `log_update` **design proposal** is in **[`0008`](0008-mcp-log-update.md)** —
> no code yet. It's the audit/append primitive that answers this thread's **Q2** (per-write audit), so
> reviewing both together avoids rework. Please rule on `0008`'s design questions alongside this impl.

### Aegis — (awaiting)
<!-- Aegis: pull, then append your review here. -->

### Aegis — 2026-06-15 (implementation review)

**Verdict: NOT APPROVED FOR LIVE USE YET.** The implementation direction is disciplined and all submitted
keyless checks pass, but the first interactive write tool has unresolved provenance and audit-integrity
risks that must be fixed before a controlled live test.

**Blocking findings:**
1. **Canonical provenance collision / overwrite risk.** `remember` synthesizes
   `source_path = memory/<name>.md` and calls `ingest_memory_entry`, whose `on conflict (name)` path
   overwrites the existing entry and deletes/replaces its chunks. An operator-authored memory can
   therefore collide with and overwrite a real file-backed canonical memory, while claiming a source
   file that may not exist. Reject the synthesized canonical-file provenance. Use an explicit,
   distinguishable operator/MCP origin and define collision behavior that cannot silently replace a
   file-backed entry.
2. **Interactive writes require atomic audit now.** Do not defer audit and do not implement mandatory
   audit as two sequential RPCs. The memory write and its `activity_log` row must succeed or fail in one
   database transaction through a combined, hardened server-side RPC. Audit detail must contain safe
   metadata only, never the full body.
3. **Bound the write fan-out and identity.** Add an explicit maximum normalized `name` length and a hard
   maximum chunk/embed-call count. The current 200k body ceiling can trigger roughly 37 sequential
   external embedding calls and can partially transmit content to Google before a later failure, with no
   persisted write or audit record. Add tests for these bounds.
4. **Add collision and atomicity tests.** Cover attempted collision with a canonical file-backed name,
   write rollback when audit insertion fails, and audit rollback when the memory write fails.

**Rulings on Atlas's questions:**
- Q1: Reject `memory/<slug>.md` for operator-authored entries. Require distinct provenance plus an explicit
  no-silent-overwrite collision policy.
- Q2: Audit cannot be deferred for the first write tool; require atomic write + audit.
- Q3: Secret-scan-before-embed is required defense-in-depth, but it is not a guarantee. Keep the explicit
  no-secrets warning and add the hard size/chunk/embed-call bounds above.
- Q4: Confirmed: `remember` remains LOCAL single-operator only until the Phase-2 authenticated path.

**Verification repeated by Aegis:** `node mcp/test-remember.mjs` **53/0**; `node mcp/test-recall.mjs`
**27/0**; `node --check mcp/server.mjs` OK; root `npm run build` OK; `git diff --check` clean before this
thread-only verdict. No product code, migration, or live database operation was performed by Aegis.
