# 0035 — PICKUP TODO: exact resume point (written 2026-07-03, Jesse switching to client work)

**Dispatch line to resume:** "Read `docs/threads/0035-pickup-todo.md`; pick up where we left off."
Everything below is current as of HEAD `1115ed2` + this doc's commit. State also mirrored in
MEMORY.md + `project_mnemosyne.md` (topic file) + the brain (recall "pipeline run 2" / "six lead board").

---

## ⏰ TIME-SENSITIVE — the dates that don't wait

| Date | Lead | Action | Owner |
|---|---|---|---|
| **~Jul 8** | **Berkeley** | RFP releases (~6-lot, $2.4M/4yr; bids ~Aug 7). **Render the capabilities-brief BEFORE release** — draft anchored in brain brief `client-brief-city-of-berkeley-adddfe64` (Suggested Angle section); lots 5 (analytics sw) + 6 (private-camera integration); data-flow one-pager doubles as Surveillance Acquisition Report input (BMC 2.99 applies) | **Jesse** (Create tab render = human-gated) |
| 7/10 | Richmond | **Verification pull before ANY collateral**: PlanetBids portal CompanyID 14590 (ci.richmond.ca.us/3300/BidsOnline) + CPRC PDF (ArchiveCenter item 17469) — is the RFP at Phase II (Flock vs Utility Associates)? If yes, pivot to Dec-31-2026 sunset re-eval positioning | Jesse (JS portal — agents can't reach it) |
| 7/14 | SacRT (HOT) | Discovery call: (1) confirm VMS/analytics vendor — THE qualifier, no public source has it; (2) verify post-Sheriff-transition leadership (Robert Kerr SOC Mgr / Vince Beatty Police Svcs — titles may be stale since the Jan 2026 SPD→County Sheriff move) | Jesse |
| 7/14 | Stockton | Start pilot-first motion per City Detect precedent: engage Code Enforcement (Almarosa Vargas — the proven buyer) + CIO Jamil Niazi (911-systems background) in parallel; AVOID Chief's office (contract uncertainty). Open lane = NEW $1M federal RTCC, vendor-undecided | Jesse |
| 7/17 | Rialto | Confirm Convergint/VMS analytics scope + Axon-Fusus overlap before outreach (complement pitch only — Axon locked thru 2031) | Jesse |
| 7/21 | Long Beach | Kurtzman LinkedIn outreach (draft IN the brain brief `client-brief-city-of-long-beach-acbcf032`); enter via Pitch Long Beach!/LB Co-Lab pilot channels, NOT PD; land before permanent TID Director starts fall 2026 | Jesse |

## 📄 COLLATERAL — the one layer NOT yet durable (from the "more info in chat than Mnemosyne" finding)

The six step-4 collateral DRAFTS live only in `C:\dev\.scratch\*.md` + chat transcript — ephemeral
by design (human-gate rule; the Stockton agent famously refused to auto-publish). **Moving them into
Mnemosyne = Jesse renders via Create tab → Save → attach to deal.** Priority order: Berkeley (clock),
SacRT (HOT), Stockton, Long Beach, Rialto. Richmond WAITS on the 7/10 verification. Scratch files:
`long_beach_brief.md`, `sacrt_brief_body.md`, `stockton_brief_body.md`, `rialto_brief_body.md`
(+ meridian fixtures, deletable). The research BRIEFS themselves are fully in the brain (byte-parity
verified) — only the polished pitch drafts are at risk of loss.

## 🔧 ENGINE BACKLOG (found in field, ranked)

1. **Browser/portal capability for the research box** — JS-rendered procurement portals (PlanetBids)
   blocked agents TWICE (Richmond, SacRT). This is now the #1 evidence gap in the loop. (Headless
   Chrome exists on this box — remember the `--user-data-dir=<scratch>` rule.)
2. **PDF-text extraction capability** — municipal evidence lives in PDFs (Richmond's Phase-II answer
   is INSIDE an unparseable PDF). poppler/pdftotext or python lib on the research box.
3. **CRM profile UI: show linked brief bodies inline** — Jesse saw less on the client profile than
   in chat because `client_360` is metadata-only BY DESIGN; if wanted, add a fetch-backed (redacted)
   body view to the client page. Mission-Control candidate.
4. **ICP maintenance (before sweep #3):** ratify the +1-signal rule (live RFP/authorized budget —
   would have made Richmond/Rialto/Oakland HOT); add transit/airport gate row (camera-count + SOC
   presence — SacRT pattern); consider "demonstrated AI-camera purchase" as signal 7 (Stockton
   pattern); date-check rule for hiring signals (stale-2024 lesson); incumbent-overlap check in
   research step 2 (Axon lesson). AB 645 six-city watchlist standing through 2032.
5. **Sweep #3 → Sonnet dispatch** (cost: ~70% off the priciest step) — ICP is 2 sweeps in; one more
   Fable-run sweep, then demote. Runbook footnotes to add: long-markdown JSON via script file not
   shell quoting (2 agents converged); urllib default-UA gets 403 from MCP WAF (curl fine).
6. **Small code items riding the next migration:** `deal_id` echo in `upsert_client_brief` return
   (Aegis-noted gap); old `recall_memory(vector,int)` retirement (telemetry shows callers now).

## 🏗️ ROADMAP QUEUE (thread 0024, after lead-gen actions clear)

1. **P1-BUS** (`agent_messages` coordination bus) — next build unit; gates the AGENTIC-OS view
   (dispatch = work-order rows agents poll, NEVER web shell-exec). Design doc = thread 0036, Atlas
   writes → Aegis → Sonnet, per the working model.
2. **P1-LIBRARIAN** (memory-hygiene cron + revert RPC) — staleness flagging matters more now that
   lead intel ages (Richmond's RFP status is already time-decaying).
3. **Mission-Control dashboard skin** (pure frontend; V.A.U.L.T. concept art in `docs/conceptUI.PNG`
   + `docs/agenticos.PNG`; vitals rail + animated node cloud already shipped as 0032 riders).
4. Thread 0021 (binary upload), browser-client CORS unit (0027 non-goal), remember/update-for-
   machines 2b unit (pending need).

## 📊 STATE SNAPSHOT (for orientation without re-reading everything)

- **Infra LIVE:** hosted MCP (6 tools: recall/fetch/log_update/brief/client_brief/client_360);
  bridge+CRM+hybrid recall (0032); prospect loop (0033); sweep runbooks + ICP (0034). Migrations
  0001–0030 applied. Key rotated, legacy keys DEAD. exec-pro machine = all 6 scopes.
- **CRM:** 7 clients / 6 active leads (Berkeley, Richmond, Rialto, SacRT, Stockton, Long Beach) +
  ExecPro demo. All 6 leads have verified, deal-linked research briefs in the brain.
- **Working model:** Atlas/Fable plans → Aegis reviews (committed into thread docs) → Sonnet builds
  → Aegis QC → Jesse apply-go → gate → smokes → live sign-off. Handoffs via committed work-order
  docs + one-line dispatch (SOP). Disagreements: falsifiable test decides; judgment calls go to
  Jesse w/ both positions.
- **Cost model:** ~$2.50-3.50/lead API-equivalent (~$7-11 per full pipeline run), 10-30× under
  market; details in 0034 doc.
- **Sweeps run:** #1 CA LE/security (17 scored, 7 WARM), #2 CA public-safety/smart-city (13 scored,
  1 HOT SacRT / 5 WARM). Artifacts in brain. Sweep #3 vertical = Jesse's call (transit sub-vertical
  is the proven pattern; AB 645 cities are a standing watchlist).

## Close-out rule for THIS doc
When resuming: work the ⏰ table first (dates may have passed — check today's date against them),
then collateral renders, then backlog/roadmap. Update this doc's items as they complete; when the
board clears, fold survivors into the next thread doc and mark this one CLOSED.
