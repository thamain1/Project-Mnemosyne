# Runbook — Prospect Sweep (lead GENERATION, thread 0034)

**Dispatch line:** "Read `docs/runbooks/prospect-sweep.md`; sweep for <product> leads in
<region/vertical>." (v1 product = IntelliOptics; ICP = `docs/runbooks/icp-intellioptics.md`.)

This is the TOP-OF-FUNNEL stage that feeds `prospect-research.md`. It produces a **scored candidate
list** — names and evidence, nothing else. It is read-only against the CRM by design.

## Hard rules

1. **NO CRM writes. NO client creation. NO client_brief calls.** The sweep's only output is a
   candidate-list memory + activity note (step 4). Clients are created by a human at triage; the
   research loop runs AFTER that, per its own runbook. (One writer shape per table; the sweep is not
   a writer.)
2. **NO outreach of any kind** — not even "just a LinkedIn view." Names and public evidence only.
3. **Every signal needs a citation.** An uncited signal scores zero. The ICP's scoring shape
   requires a one-line source per fired signal.
4. **Score against the committed ICP file, not vibes.** If a candidate feels right but fails the
   gate, it goes in as PARK/DEAD with the reason — the miss is signal for the ICP's maintenance
   section, not a rule to bend.
5. **Check for collisions before scoring:** `client_360` each candidate name — if they're already a
   CRM client or match an existing deal, mark them `EXISTING — see CRM` and do not re-score; the
   stale-deal digest owns warm pipeline, not the sweep.

## The sweep

### 1. LOAD

Read the ICP file for the named product. Note its git SHA — the output cites it.

### 2. HUNT (agent-side web research — you are the crawler)

Work the ICP's signal list as SEARCH STRATEGIES, not just checkboxes. For IntelliOptics that means,
at minimum, one pass over each modality:

- **Job boards** (Indeed, LinkedIn Jobs, regional boards): "quality inspector", "QC technician",
  "visual inspection" + the target region/verticals — companies hiring for eyes.
- **Trade + local business press**: expansion/certification/contract announcements in the ICP
  sectors (regional business journals punch above their weight here).
- **Cert registries/announcements**: AS9100/ISO newly-certified or recertifying companies.
- **Integrator/vendor case studies**: camera/automation integrators naming manufacturer clients
  (camera-adjacent = signal 5).
- **Directories/associations**: regional manufacturing association member lists for the gate scan.

Target: 10–20 gate-passing candidates per sweep. If a region/vertical yields <5, say so and widen
ONE notch (adjacent region or vertical) — note the widening in the output.

### 3. SCORE

Grade every candidate in the ICP's exact output shape (gate → signals w/ citations → disqualifiers
→ people → verdict). HOT/WARM/PARK/DEAD — no other labels.

### 4. PERSIST + REPORT

- Write ONE memory via `remember` (operator session) or `log_update` w/ `agent.note` (hosted
  machine — remember is not exposed remotely): title
  `Prospect Sweep — <product> — <region/vertical> — <YYYY-MM-DD>`, body = the full scored list +
  ICP SHA + search-modality notes. This is a SWEEP ARTIFACT, kind `reference` — it is not a client
  brief and links to no client (none exist yet, by design).
- Post the topline as the handoff: N candidates, N hot / N warm, top-3 one-liners, and the explicit
  ask: **"Triage: which do I create in the CRM?"**

### 5. HUMAN TRIAGE (not the agent's step — the contract)

Jesse reviews, picks winners, creates them as CRM clients (+ a deal if warranted). THEN each pick
gets the research loop: "Read `docs/runbooks/prospect-research.md`; research <lead>." The sweep
artifact is the research loop's step-1 grounding bonus — recall will surface it once the client
exists and the brief links up.

## Cadence

Weekly, manually dispatched for the first 2–3 cycles while the ICP scoring tunes (expect the first
sweep to over-include — that's what triage is for). Automate the trigger only after two consecutive
sweeps where triage accepts ≥30% of HOTs.

## Non-goals (v1)

- Scraping infrastructure, bulk enrichment APIs, purchased lead lists — the agent's own research
  tools only.
- Contact-info harvesting beyond names/titles/public surfaces.
- Any scoring product other than IntelliOptics until a second ICP file exists.
