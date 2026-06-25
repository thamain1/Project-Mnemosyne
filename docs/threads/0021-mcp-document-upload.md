# 0021 — MCP document/file upload (store final deliverables in the brain)

**Status:** OPEN — owner Atlas

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
