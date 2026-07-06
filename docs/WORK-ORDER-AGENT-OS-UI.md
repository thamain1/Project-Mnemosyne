# WORK ORDER — Agent OS section + node-cloud animation (Mnemosyne dashboard)

**Created:** 2026-07-06 (Atlas, from Jesse's direction + reference images) · **Repo:** `C:\Dev\Project-Mnemosyne`, branch `main`
**Status:** 📋 READY FOR PICKUP
**Jesse's words (docs/UIandAgentIdeal.md, top note):** *"I am not suggesting we redo the whole UI, but I greatly favor the Agentic OS and at least animating the node cloud we have in Mnemosyne for now."* Plus: *"The agent section within Mnemosyne should be seen in a new Agent OS section."*
**References (in docs/):** `agenticos.PNG` (the conductor-board structure: client → conductor → domain columns w/ status-tagged rows), `conceptUI.PNG` (the VAULT HUD — animated particle node cloud as centerpiece), `current.png` (Mnemosyne today). These are DIRECTIONAL — adopt the structure and the energy, keep Mnemosyne's existing dark design language and component patterns. Not a pixel clone, not a rebrand, no new CSS framework.

## Ground rules (this repo's standards)

Read `CLAUDE.md` + the existing dashboard sources first (nav, Memories graph view, Activity view — reuse their data-access and component patterns). Secrets from `context.env`; no new chart/graph library unless the graph view already lacks one (it doesn't — reuse whatever renders the current force graph). Migrations `00NN_name.sql`, additive. **Do NOT touch Berkeley/lead-gen/threads 0035/0036.** Commit style per repo; `npm run build` green before push; CF Pages deploys on push to main.

## Part 1 — "Agent OS" nav section (the new surface)

A new top-nav entry **"Agent OS"** between Activity and Team (or wherever the nav reads naturally — note the choice). Team-member visible (existing auth gate); no anon access.

**Layout, in the spirit of `agenticos.PNG`** — a conductor board, top-down:
1. **Header band**: Mnemosyne as the conductor node; a system-status strip with REAL aggregates (registered clients count, agent events last 7d, agent memories count, last event time). Every number from live data — the ISB truth standard applies here too: no constants, no placeholders.
2. **One column per registered agent client** (v1 renders exactly one: Dunaway ISB Demo; the layout must not assume one — flex/grid that holds 2–6 columns cleanly):
   - **Client card**: display name, slug chip, live/idle status (live = `last_used_at` within 10 min; idle otherwise; inactive = `is_active false`), calls last 7d (from usage/activity), memory count (tags `client:<slug>`).
   - **Event feed**: latest `agent.*` activity rows for this client (event-type chip w/ per-type color — `dispatch_rejected` amber, `contract_lost` red, `contract_won` green, `dispatch_override` purple, `note` blue — legend row like the reference's manual/skill/routine/agent legend), summary text, relative time. Paginated/`show more`, newest first.
   - **Learned memories**: the client-tagged `memory_entries` (title + kind chip + age), linking into the existing memory detail view if one exists (check; else title-only).
3. **Data access — SECURITY NOTE (the one sharp edge):** `agent_clients` is service-role-only and MUST stay that way — `token_hash` can never reach the browser. Build the dashboard read path as either a SECURITY DEFINER function or a view exposing ONLY `client_slug, display_name, is_active, created_at, last_used_at` (no hash column, ever), granted to authenticated team members via the house RLS pattern. Activity + memories already have team RLS reads — reuse them (filter `action like 'agent.%'` / `tags @> '{client:<slug>}'`).

## Part 2 — Animate the node cloud (Memories graph)

The current graph view (`current.png`) is functionally right but static. Bring it toward `conceptUI.PNG`'s living-cloud energy WITHOUT changing its data or interactions:
- **Idle motion**: gentle continuous drift (keep the force simulation warm at low alpha, or a subtle per-node oscillation) — the cloud should feel alive at rest, not frozen.
- **Pulse/glow on hover + selection** (nodes and their linked edges highlight; already partially there per the legend — amplify tastefully).
- **Entrance animation** on load (nodes settle in rather than popping).
- **Performance guard**: the sim must idle cheap (requestAnimationFrame throttled or alpha floor low; laptop-fan test — note what you did). Node count is ~150 today; assume up to ~2,000 without jank.
- **No regressions**: click-to-open, zoom, pan, filter chips, search — all exactly as before. If the animation fights usability (drift makes clicking hard), damp motion on pointer-over the canvas.
- (Optional, only if cheap: agent-sourced memories — provenance `agent/...` — get a distinct node color + legend entry. That visually lands "the brain is learning from the field" for demos.)

## Verify + close out

1. Agent OS section renders with the REAL Dunaway ISB Demo client: correct status/counts against direct SQL (paste both), the smoke-test-era activity/memories if any survive, or seed 1–2 real-shaped demo events via the deployed `/api/agent-outcome` (disposable test client, cleaned up) to prove the feed renders live data end-to-end.
2. `token_hash` provably unreachable: the dashboard read path's grants checked, AND a browser-session probe (the ISB-walk token technique) confirming a team member's session cannot select the hash column/raw table.
3. Node cloud: idle motion visible, hover pulse works, all pre-existing interactions regression-checked (click/zoom/pan/filter/search), CPU sane when idle (describe the check).
4. `npm run build` green; commit (incl. the three reference images + `UIandAgentIdeal.md` as committed design refs — they're the "why" for this surface); push (CF deploys); Receiver log + Mnemosyne `log_update`; screenshots of both surfaces in the log.
5. Flag, don't touch: the other untracked files (`scripts/rename-emails.mjs`, `reset-one-password.mjs`, `.scratch/`, `openbrain.md`, `cf.PNG`, `header.PNG`) — Jesse's to disposition.

## OUT of scope

Full UI redesign (Jesse's explicit line). New sections beyond Agent OS. Skills/automations codification (the video's Case-2 material — separate conversation). Agent-client CRUD dashboard (provisioning stays script-based). Public/anon surfaces. Berkeley/lead-gen anything.

---

## Receiver log

*(Executor: append findings, deviations, and verification evidence here.)*

---

## Receiver log — executed by Atlas, 2026-07-06

**Migration `0032_agent_clients_overview.sql`** (applied live, verified): `list_agent_clients()` SECURITY DEFINER fn — team-member-gated, returns exactly 5 safe columns; a view was considered and REJECTED because postgres-owned views bypass RLS silently (the ISB-0022C lesson) and a definer fn's explicit column list is the narrower contract. `token_hash` is not in the return signature — unreachable by construction.

**Part 1 — Agent OS section** (`src/pages/AgentOS.tsx`, nav between Activity and Team — "what the machines did" next to "what the humans did"): conductor header band w/ live aggregates; event-type legend (6 chips, WO colors); per-client columns (status live<10min/idle/inactive, events·7d, memory count, last-used; paginated event feed w/ chip+summary; learned-memories list w/ kind chips). Grid holds 1–6 columns (proven with 2 during the walk).

**Part 2 — node cloud**: recon found thread 0032 already built bounded idle drift + hover particles + zoom-to-node, with documented reasons for the bounds (unbounded physics drifted nodes off-camera). Respected that design: added **render-layer breathing** — per-node phase-offset radius oscillation + soft glow halo driven by Date.now() in nodeCanvasObject — physics never re-heats, click targets never move, zoomToFit's frame never re-inflates. Plus the WO's optional agent-learned node color (cyan) + legend entry.

**Walk evidence (temp team member, deleted after; shots M1–M3 in Atlas scratchpad + pasted to Jesse):**
- Agent OS renders REAL data: `dunaway-isb-demo` card w/ genuine last-used; disposable `walk-test` client minted → 2 events fired through the DEPLOYED `/api/agent-outcome` → column went **live** w/ pulse, chips + summaries rendered, and **the distill rule showed up in the numbers: 2 events → 1 memory** (rejection learned, plain win logged only).
- **Three walk findings fixed in-session**: (1) header aggregates counted orphaned deleted-client events (8 vs the column's honest 0) → header now counts registered-client events only; (2) `relTime` rendered "-60s ago" on server-stamped rows ahead of the local clock → clamped at 0; (3) *(pre-emptive)* the memories fetch comment misdescribed a no-op filter → removed the no-op, documented the in-memory client:-prefix filter honestly.
- **token_hash negative proven with a real session** (password-grant login as the temp member): direct `select=token_hash` → **42501 permission denied**; `rpc/list_agent_clients` → the 5 safe columns, nothing else.
- Graph: cohesive cloud w/ visible glow halos, agent-learned legend present, all pre-existing interactions intact, 0 console errors on every walk pass.

**Cleanup verified**: walk-test client + its activity/memory rows deleted (registry back to exactly `dunaway-isb-demo`), temp team member fully removed, my dev server (port 5175) stopped — Sonnet's 5174 untouched.

**Committed**: migration, AgentOS page, nav wiring, MemoryGraph breathing/agent-color, this WO + AGENT-API WO refs, and the four design-reference files (`agenticos.PNG`, `conceptUI.PNG`, `current.png`, `UIandAgentIdeal.md`). **Flagged, untouched, Jesse's to disposition**: `scripts/rename-emails.mjs`, `scripts/reset-one-password.mjs`, `.scratch/`, `openbrain.md`, `cf.PNG`, `header.PNG`.
