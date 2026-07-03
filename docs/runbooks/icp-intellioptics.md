# ICP — IntelliOptics 2.5 (visual-inspection AI)

**Purpose:** the scoring spec `prospect-sweep.md` grades candidates against. One ICP file per
product; this is the first. Keep it honest — every criterion here must be OBSERVABLE from public
signals, not aspirational ("companies that would benefit" is not a criterion; "companies hiring a
second quality inspector" is).

## The one-sentence fit

Mid-size manufacturers/fabricators whose quality process depends on **human visual inspection** that
is now a stated or visible bottleneck, with cameras already normal on their floor and no ML/vision
tooling in sight.

## Firmographics (gate — must pass ALL)

| Criterion | Pass band | Why |
|---|---|---|
| Size | ~20–200 employees | Big enough to have QA budget + real throughput pain; small enough that 4ward's pilot pricing and sales motion fit. |
| Sector | Precision manufacturing, sheet-metal/CNC fabrication, injection molding, PCB/electronics assembly, medical-device or aerospace suppliers, food/bev packaging QA | Physical products with visual defect classes a camera can see. |
| Geography | US, EST/CST preferred for v1 | Pilot support hours; travel-cheap site visits from NC. |
| Quality regime | Certified or pursuing AS9100 / ISO 9001 / ISO 13485 / FDA-regulated | Cert pressure = documented inspection burden = budget owner exists. |

## Signals — why NOW (score 1 pt each; ≥2 = sweep-worthy, ≥3 = hot)

1. **Hiring quality inspectors** — job posting(s) for QC/quality-inspector roles in the last 90 days
   (Indeed/LinkedIn/company careers page). The single strongest signal: they're solving inspection
   capacity with headcount RIGHT NOW.
2. **Cert push** — announced recertification, first-time cert pursuit, or audit-prep language in
   news/LinkedIn posts.
3. **Growth event** — new facility, new line, funding, major contract win (trade press, local
   business journals, PR).
4. **Stated pain** — an executive quoted anywhere saying inspection/quality/scrap/rework is a
   bottleneck or cost center.
5. **Camera-adjacent infrastructure** — security/process cameras visible in facility photos, an
   integrator case study naming them, or machine-vision-adjacent tooling that stopped short of ML.
6. **Scrap/rework economics** — any public number on defect cost, returns, or warranty claims.

## Disqualifiers (any ONE kills the candidate — record why, don't argue with it)

- Already running an ML-vision QA product (Cognex/Landing AI/Instrumental/etc. visible).
- Fully automated inspection already (no human-visual step to augment).
- <15 employees (no budget owner) or enterprise (>500, wrong sales motion for a pilot).
- Active layoffs/distress news (no discretionary budget).
- A direct competitor of an existing 4ward client in the same niche+region (check `client_360`).

## Who to find (people layer)

- **Budget owner:** VP Operations / Director of Quality / Plant Manager.
- **Day-to-day champion:** Quality Manager / QA Lead.
- Record: name, title, background (prior employers matter — ex-aero/med-device people GET cert
  pain), and the best public contact surface. NO outreach from the sweep — names only.

## Scoring output shape (what the sweep runbook records per candidate)

```
- <Company> — <city, state> — <sector> — ~<headcount>
  GATE: pass/fail (which firmographic failed, if fail)
  SIGNALS (n/6): [numbered list of which fired, each with a one-line source citation]
  DISQUALIFIERS: none | <which>
  PEOPLE: <names/titles found, or "not yet identified">
  VERDICT: HOT (gate + ≥3 signals) / WARM (gate + 2) / PARK (gate + <2) / DEAD (disqualified)
```

## Maintenance

Update this file when: pilot pricing changes the size band; a vertical proves out (promote it) or
dead-ends (demote it); a new disqualifier shows up in lost deals. Every sweep run cites the ICP
version it scored against (git SHA is fine).
