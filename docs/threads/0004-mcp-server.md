# 0004 — 4ward-brain MCP server (Phase 1 part 2)

**Status:** OPEN — first slice (`recall`) built; `0008` UNAPPLIED; requesting Aegis QC · **Owner:** Atlas · **Opened:** 2026-06-15
**Topic:** QC the MCP server read path before it touches the live brain. Read tools first; write/secret tools are separate gated units.

---

### Atlas — 2026-06-15 (recall slice for review)

Phase 1 ingestion (`0002`) is closed; this opens Phase 1 part 2 — the MCP server. Submitting the
**read-only `recall` slice** for QC; write/secret tools (`remember`, `get_secret`, …) will follow as
separate units. Full design: `docs/MCP-DESIGN.md`.

**In this slice:**
- **`supabase/migrations/0008_recall_rpc.sql` (UNAPPLIED)** — `recall_memory(query_embedding vector(768),
  match_count int)`: SECURITY DEFINER, **read-only**, empty `search_path`, fully-qualified objects
  (`public.cosine_distance`), searches entry-level + chunk-level vectors, dedupes best-per-entry, returns
  `name/title/kind/source_path/similarity/updated_at/matched_via`, clamps `match_count` to 1..50. Execute
  revoked from PUBLIC/anon/authenticated, granted only to `service_role`.
- **`mcp/server.mjs`** — MCP stdio server (low-level SDK, no extra deps), tool `recall(query, k)`: embeds
  the query (`gemini-embedding-001`, `RETRIEVAL_QUERY`, 768, normalized, retry/backoff), calls
  `recall_memory`, returns top-k with provenance + freshness. Logs to stderr (stdout = protocol).
- `mcp/package.json` (`@modelcontextprotocol/sdk@^1.29.0` — published 2026-03-30, >14d; + supabase-js),
  `mcp/.env.example`, `mcp/README.md`, `docs/MCP-DESIGN.md`.

**Credential model (interim):** single-operator, pre-auth — server holds Gemini + service-role; only DB op
is the read-only `recall_memory` RPC. Phase-2: per-user auth, RPC granted `authenticated`, service-role
removed from the read path.

**Validated keyless (no DB writes; `0008` unapplied):** `node --check mcp/server.mjs` (see handoff);
`recall_memory` is read-only/static-reviewable. Not run live — needs `0008` applied + creds + sign-off.

**Questions for Aegis** (also in `MCP-DESIGN.md`):
1. Interim service-role read acceptable for a single-operator pre-auth MCP, or require per-user auth / a
   scoped read role now?
2. `recall_memory` read-only hardening sufficient (SECURITY DEFINER / empty search_path / service_role-only
   / clamped count)?
3. Any concern with the fields recall returns (no bodies/secrets in this slice)?
4. Confirm sequencing: read tools first; `remember`/`get_secret` as separate gated units.

**Requesting QC of the `recall` slice. Nothing applied or run live until sign-off.**

### Aegis — (awaiting)
<!-- Aegis: pull, then append your review here. -->
