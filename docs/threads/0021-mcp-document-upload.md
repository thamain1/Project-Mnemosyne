# 0021 — MCP document/file upload (store final deliverables in the brain)

**Status:** OPEN (NARROWED 2026-06-29) — owner Atlas. **Most of the original scope was delivered by thread
`0023` Phase D** (private Storage bucket + governed persist + signed-URL download). 0021 now covers ONLY the
**arbitrary / externally-produced binary upload via the MCP** (files NOT produced by the render factory). See
the "Scope narrowed" section at the bottom for the precise remaining work.

## Problem

The Mnemosyne MCP toolset (`recall`, `remember`, `log_update`, `get_secret`) has **no way to upload a
binary/file deliverable** (PDF, DOCX, image). `remember` takes markdown text only and is meant for memory
entries, not document storage; `log_update` is an append-only activity record. So when a finished artifact
exists on an operator's machine, there is no governed path to push the actual file into the shared brain —
only a text pointer can be recorded.

This surfaced 2026-06-24 while delivering two 4ward-branded GIAV client reports for Beth Underhill
(`GIAV-STRATEGY-REPORT` ~42pp, `GIAV-FUNDING-REPORT` ~26pp, in `C:\Dev\Recon\`). The activity was logged
(`work.deliverable`) and a pointer memory was registered, but the PDFs themselves could not be uploaded.

## What to build (to-do)

Add a governed document-upload capability to the MCP + backend so an operator can push a final file into
the brain and have it discoverable in the dashboard.

- [ ] **New MCP tool** (e.g. `upload_document`) — accepts a local file path (or base64 + filename + mime),
      optional `deal_id`/`project`/`kind`, and a short description.
- [ ] **Storage target** — a Supabase Storage bucket (service-role-only, like `search_docs`); decide bucket
      name + path convention (e.g. `deliverables/<project>/<filename>`).
- [ ] **Trust model** — follow the Phase-2 pattern from [0004](0004-mcp-server.md): the file goes up via an
      authenticated CF Pages Function (`JWT → active member → service-role write`), so the operator never
      holds the service-role/storage key. Do **not** ship a direct storage key in the stdio MCP.
- [ ] **Governance / sealing** — run the prohibited-content / secret scanner
      (`functions/_lib/contract-scan.ts`) before accepting; respect the Sealed Credential standard
      (`TOKEN-GOVERNANCE-SYSTEM.md` §19). Client-facing deliverables only; refuse files containing live
      secrets.
- [ ] **Metadata + dashboard** — register a row (reuse/extend `documents`, which already has `deal_id`/
      `origin`) so uploaded files show in the Documents tab and can be linked to a CRM deal (C5).
- [ ] **Optional: re-embed** text-extractable uploads (PDF → text → chunk + embed) so they're recallable,
      mirroring the C4.2 `save_document` arc ([0018](0018-sales-factory-c4.2.md)).

## Open questions

- Store binaries in Supabase Storage vs. keep brain text-only and just index external paths?
- Size limits / allowed mime types.
- Does this fold into the Phase-2 remote-MCP work (no service-role on remotes) or ship first as a
  local-operator-only tool like the current MCP?

### Atlas — 2026-06-24

Filed at Jesse's request after the GIAV-for-Beth delivery hit the missing-upload gap. Recommend building it
behind the existing CF Pages Function trust model (never a storage key in the MCP) and reusing the
`documents` table + contract-scan governance already shipped for the sales factory, rather than inventing a
parallel store. Not started; no migration/endpoint yet.

### Atlas — 2026-06-29 (scope narrowed after thread 0023 Phase D)

Thread `0023` Phase D (live, Aegis-approved `1df248f`) **delivered most of what 0021 originally proposed**, so
0021 shrinks to the one piece Phase D deliberately excluded.

**DONE by 0023 Phase D (no longer 0021's work):**
- ✅ **Storage target** — private, service-role-only Supabase Storage bucket `documents` (PDF-only, 25 MB),
  immutable paths `rendered/{id}/v1.pdf`, no client/anon/authenticated Storage policies.
- ✅ **Trust model** — server-mediated: JWT → active member → governed render → service-role upload; the
  browser/client never holds a Storage key; downloads via member-auth **60s signed URLs** (`/api/document-download`).
- ✅ **Governance/sealing** — `contract-scan` policy-split runs before store; secrets/markers always blocked.
- ✅ **Metadata + dashboard** — reuses the `documents` table (`origin='rendered'`, `deal_id`) + `document_versions`;
  shows in the Documents tab with download; CRM-attachable.

**REMAINING (0021's narrowed scope) — arbitrary / externally-produced binary upload via the MCP:**
The Phase-D path only persists **factory-rendered PDFs from governed markdown** (the server produces the bytes).
0021 is now specifically: a governed way to push a binary the factory did NOT produce — an externally-made
**PDF/DOCX/image** (e.g. a counterpart-signed contract, a designer's deck, a scan) into the brain.

- [ ] **Decide the bytes-trust posture** — the hard difference from Phase D: here the client SUPPLIES the bytes
      (Phase D forbids that). Need a safe ingest: size/MIME allow-list, server-side content sniff (magic bytes
      match claimed type), AV/secret-scan where feasible, and a distinct `origin='uploaded'` (NOT `'rendered'`)
      so provenance can never be confused with a governed render.
- [ ] **MCP surface** — an `upload_document` tool that does NOT hold a Storage/service-role key on the operator's
      machine: route bytes through an authenticated CF Function (the Phase-D trust model), or chunk via the
      existing RPC pattern. Resolve how an stdio MCP streams a binary safely.
- [ ] **Storage path convention** for uploads — e.g. `uploaded/{id}/<filename>`, immutable, distinct from
      `rendered/`. Extend the bucket's allowed MIME types beyond `application/pdf` (carefully) if DOCX/images
      are in scope.
- [ ] **Reuse, don't rebuild** — same `documents` + `document_versions` + signed-URL download already shipped;
      0021 adds the upload ingress + the bytes-trust controls + the `origin='uploaded'` value.
- [ ] **(Optional) text-extract + RAG** — if uploaded PDFs/DOCX should be searchable, extract text → chunk →
      embed (the C4.2 pattern). Same deferral as Phase D's download-only call; decide explicitly.

**Open questions (revised):** (1) which client surface first — MCP `upload_document`, or a dashboard
file-picker upload (reuses Phase-D auth more directly)? (2) MIME scope — PDF-only first, or PDF+DOCX+images?
(3) bytes-trust depth — is server-side magic-byte sniff + secret-scan + size cap enough, or is AV required?
Still not started; design-first when picked up (crosses the integrity boundary like Phase D did).
