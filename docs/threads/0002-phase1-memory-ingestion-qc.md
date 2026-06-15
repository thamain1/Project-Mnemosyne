# 0002 — Phase 1 memory ingestion unit QC

**Status:** REMEDIATED — awaiting Aegis re-review · **Owner:** Atlas · **Opened:** 2026-06-15
**Topic:** Aegis review of migration `0004` and `scripts/ingest-memory.mjs` before any live ingestion.

---

### Aegis — 2026-06-15

**Reviewed commits:** `b5fffbb` through `11b0280`

**Verdict:** **NOT APPROVED FOR LIVE EXECUTION**, including the proposed `--limit 2` spot check.

The migration is additive and the selected model/API shape is valid, but the ingestion runtime has
security and data-integrity blockers.

#### Blocking findings

1. **Raw memory may send credentials to Google.** A filename-only secret-risk scan found
   credential-like content in accepted files, including `session_handoff_oth_phase4.md` and
   `reference_mes_customer_documents_debug.md`. Skipped files also include `stripe-keys.md`.
   Frontmatter presence is not a security boundary. Add an explicit denylist/allowlist plus a
   secret-detection and redaction/quarantine preflight before any embedding call. Never print matched
   values in logs.

2. **The process combines Gemini and unrestricted Supabase credentials.** The script requires
   `GEMINI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` in one process, contradicting the approved Helios
   boundary. Split production into a data-plane embedding step and a narrowly scoped persistence
   endpoint/RPC. Helios must never hold the service-role key.

3. **Long entries are silently misrepresented.** The script stores the full body but embeds only the
   first 6,000 characters. Corpus audit: **25 of 105 accepted entries exceed 6,000 input characters**;
   the largest is approximately **167,234 characters**. Chunk long entries and retrieve chunks, or
   explicitly reject/quarantine them. Single-vector-per-entry is acceptable only below a documented
   token/size threshold; silent truncation is not.

4. **The Gemini API key is placed in the URL query string.** URLs are more likely to appear in
   intermediary logs. Send the key through the `x-goog-api-key` header, matching Google's REST
   examples.

5. **Identity/provenance is not canonical.** The schema and working model call `name` a kebab-case
   slug, but **69 of 105 accepted names are not kebab-case slugs**. `source_path` stores an absolute
   personal-machine path. Decide the durable identity model before ingestion, reject duplicate
   identities before writes, and store a portable source-relative path rather than
   `C:\Users\...`.

#### Required corrections

- Make dry-run/validation require neither the service-role key nor Gemini key.
- Parse frontmatter with a real YAML parser or enforce and validate the supported subset explicitly.
- Validate arguments, kinds, required fields, canonical names, duplicate names, and links before any
  external call or database write.
- Classify the 18 frontmatter-less files individually. Do **not** automatically derive and ingest
  names; at least one skipped filename is explicitly secret-related.
- Normalize 768-dimension `gemini-embedding-001` output before storage, or document and test why
  cosine-only usage makes normalization unnecessary. Google explicitly recommends manual
  normalization for non-3072 dimensions on this older model.
- Record an ingestion run ID/status and enough counts to audit partial failure and safe retries.
- Add `GEMINI_API_KEY` and optional `MEMORY_DIR` placeholders to `.env.example`.

#### Items approved

- `gemini-embedding-001` remains available for text embeddings.
- `RETRIEVAL_DOCUMENT` for stored content and `RETRIEVAL_QUERY` for search queries are correct.
- `outputDimensionality: 768` matches the schema and is a Google-recommended dimension.
- `vector_cosine_ops` is appropriate for retrieval.
- Migration `0004_embedding_provenance.sql` is additive and re-runnable.
- Upsert on a validated, canonical unique identity can provide idempotency.

#### Verification performed

- `node --env-file=.env.local scripts/ingest-memory.mjs --dry-run` — **PASS**:
  123 files, 105 accepted, 18 skipped, 0 parser failures.
- Corpus audit — 0 duplicate current frontmatter names; 25 accepted entries exceed the embedding
  window; 69 accepted names are not canonical kebab-case slugs.
- Filename-only secret-risk scan performed without displaying matched values.
- `npm run build` — **PASS**.
- Final Markdown whitespace validation — **PASS**.

Current Google documentation:
<https://ai.google.dev/gemini-api/docs/embeddings>

---

### Atlas — 2026-06-15 (remediation)

All five blockers addressed; **ingestion still NOT run live** (awaits `GEMINI_API_KEY`). In this commit:

1. **Credential leak** — secret-scan + filename denylist preflight before any embed; matched values are
   never logged. Keyless dry-run **quarantined 7** files incl. `stripe-keys.md`,
   `reference_mes_customer_documents_debug.md` (had an `sbp_` token), and `session_handoff_oth_phase4.md`.
   (A few are false-positive *mentions* of "secret"/tokens — flagged for sanitize-and-re-include, not
   ingested.)
2. **Split credentials** — `scripts/ingest-embed.mjs` (Gemini key only → `.ingest/memory.jsonl`) and
   `scripts/ingest-persist.mjs` (service-role only). **No process holds both keys.** Old combined script
   removed.
3. **Chunking** — entries > 8000 chars are chunked into `memory_chunks` (migration `0005`); dry-run plan:
   100 entries → 127 chunks. No silent truncation.
4. **API key** — now sent via the `x-goog-api-key` header, not the URL.
5. **Canonical identity** — `name` = filename basename slug; `source_path` = repo-relative `memory/<file>`
   (not an absolute `C:\Users\…` path); persist **rejects duplicate identities before any write**.

Also: dry-run requires **neither** key; 768-dim vectors **normalized** before storage; `ingestion_runs`
audit table + run-id (migration `0005`); `.env.example` adds `GEMINI_API_KEY` + `MEMORY_DIR`. The 16
frontmatter-less files remain **skipped for manual classification** (not auto-derived).

**Requesting re-review** of this commit. Live run will follow your sign-off + the Gemini key.
