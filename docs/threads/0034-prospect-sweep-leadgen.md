# 0034 — Prospect sweep: lead GENERATION for IntelliOptics (docs-only unit)

- **Opened:** 2026-07-03 (Fable/Atlas, on Jesse's "how do we turn this into a lead generator for
  IntelliOptics" + go)
- **Status:** DOCS WRITTEN — awaiting Aegis review (light: no migration, no code, no new tool
  surface; the unit is two runbooks + this thread). Then the first real sweep runs.
- **Unit:** completes the P2 lead-gen pillar's front end. Thread 0033 built the lead PROCESSOR
  (research loop: name in → grounded brief + collateral out); this adds the GENERATOR (ICP-scored
  candidate sourcing) in front of it. Ships ahead of P1-BUS because it touches nothing structural.

## What ships

1. **`docs/runbooks/icp-intellioptics.md`** — the scoring spec: firmographic gate (20–200 person US
   manufacturers/fabricators under a quality-cert regime), 6 observable why-now signals (hiring
   inspectors, cert push, growth event, stated pain, camera-adjacent infra, scrap economics; ≥2 =
   sweep-worthy, ≥3 = HOT), hard disqualifiers (existing ML-vision tooling, no human-visual step,
   size out of band, distress, client-conflict), people layer (VP Ops/Quality Manager), exact
   per-candidate output shape, and a maintenance contract (every criterion must be OBSERVABLE;
   update on pricing/vertical/lost-deal evidence).
2. **`docs/runbooks/prospect-sweep.md`** — the generator runbook: LOAD (ICP + SHA) → HUNT (5 search
   modalities: job boards, trade/local press, cert registries, integrator case studies,
   directories; 10–20 gate-passing candidates; widen one notch if <5, noted) → SCORE (ICP shape,
   HOT/WARM/PARK/DEAD only) → PERSIST + REPORT (one sweep-artifact memory + topline handoff ending
   in "Triage: which do I create in the CRM?") → HUMAN TRIAGE (Jesse creates winners in CRM, then
   each gets the 0033 research loop).

## Governance posture (why this is safe as a docs-only unit)

- The sweep is **read-only against the CRM** (hard rule 1): no client creation, no client_brief, no
  writes except its own sweep-artifact memory (via `remember` locally / `agent.note` hosted — both
  existing, already-gated paths). The human-triage gate between sweep and CRM is the same
  deliberate one-writer-shape rule 0033 enforced.
- No outreach of any kind (hard rule 2) — stricter than the research loop (which at least drafts).
- Collision check via `client_360` keeps the sweep off warm pipeline (the stale-deal digest owns
  that).
- Nothing new for Aegis to gate at the schema/endpoint layer — review is editorial: are the hard
  rules airtight as written, is the scoring shape honest, is the triage contract unambiguous.

## The full engine, end to end (now complete on paper)

```
weekly: "sweep for IntelliOptics leads in <region>"        (0034, agent, read-only)
  → scored candidate list → Jesse triage → CRM clients      (human gate)
  → per pick: "research <lead>"                             (0033 loop: brief + collateral)
  → human renders/sends via Create tab + own email          (human gate)
  → stale-deal digest keeps pipeline warm                   (0032 cron)
  → first WIN becomes the citable case study                (collateral flywheel: case-study
                                                             doc type is already live, waiting)
```

## Acceptance (for Aegis's editorial review + the first live run)

1. Aegis editorial pass on both runbooks: hard rules airtight, no path from sweep to CRM write or
   outreach, scoring shape unambiguous to a cold agent (the 0033 dry-run standard).
2. First real sweep (Jesse-dispatched, region/vertical of his choice) produces a scored list in the
   committed shape with ≥1 HOT or an honest "widened and still thin" report — and writes NOTHING to
   the CRM.
3. Triage happens; at least one pick flows through the 0033 loop against a REAL company — the first
   revenue-path execution end to end.

## Non-goals

Scraping/enrichment infra, purchased lists, contact harvesting, auto-outreach, multi-product ICPs
(second product = second ICP file when needed), automating the weekly trigger before the ICP proves
out (2 consecutive sweeps w/ ≥30% HOT acceptance at triage).
