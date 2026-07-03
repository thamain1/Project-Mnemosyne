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

---

## Aegis Editorial Pass - 2026-07-03

**Verdict: APPROVED AS DOCS-ONLY, with two editorial clarifications required before the first live sweep.** No code, migration, endpoint, or schema gate is involved. The posture is correct: the sweep is a generator, not a CRM writer; the only permitted persistence is one sweep-artifact memory/activity note; human triage remains the boundary before CRM creation or the 0033 research loop.

### What is airtight

- The no-CRM-write rule is explicit: no client creation, no `client_brief`, no CRM mutation during sweep.
- The no-outreach rule is explicit and stricter than 0033.
- The citation rule is strong: uncited signals score zero.
- The sweep artifact is correctly modeled as a non-client-linked `reference`, not a client brief.
- The handoff contract is clear: scored list -> Jesse triage -> human-created CRM record -> 0033 loop.

### Editorial Clarifications Needed

1. **Resolve the `EXISTING` label conflict.** `prospect-sweep.md` says HOT/WARM/PARK/DEAD only, but the collision rule says mark CRM collisions as `EXISTING - see CRM`. A cold agent will not know whether `EXISTING` is an allowed fifth verdict or a pre-score exclusion state. Recommendation: make `EXISTING` an explicit pre-score disposition outside the verdict set, and state that existing CRM matches are excluded from HOT/WARM counts.

2. **Define the verdict for firmographic gate failures.** `icp-intellioptics.md` says firmographics must pass all, while `prospect-sweep.md` says a candidate that feels right but fails the gate goes in as PARK/DEAD. That leaves ambiguity: geography/quality-regime misses are not the same as hard disqualifiers. Recommendation: state one rule exactly, e.g. `Gate fail + no hard disqualifier = PARK / out-of-scope`, while `any hard disqualifier = DEAD`; HOT/WARM require gate pass.

### Minor Clarity Note

The no-outreach rule says not even a LinkedIn view, while the hunt section permits LinkedIn Jobs and the people layer asks for public contact surfaces. That is defensible if the intent is "no profile viewing/engagement from an authenticated account," but a cold agent may over-avoid public LinkedIn job pages. Recommendation: clarify allowed public source viewing versus prohibited social engagement/profile-view outreach.

### Aegis Assessment

The hard rules are substantively sound. The scoring model is almost cold-agent ready, but the two label/disposition clarifications above should be made before the first live sweep so the first artifact has clean counts and no invented verdict category.

---

## SWEEP #1 EXECUTED — 2026-07-03 (Fable, live web research)

Dispatch: "sweep the California law enforcement and security firms for IntelliOptics" (Jesse).
Pre-work: Aegis's 3 editorial clarifications applied to the runbook; **ICP Segment B added**
(LE/security vertical — Jesse-directed, grounded in IntelliOptics' shipped forensic-search/vehicle-ID/
camera-network features) @ `f4974e4`, per the ICP's own maintenance contract.

**Result:** 17 candidates scored, 0 CRM collisions, **0 HOT / 7 WARM / 7 PARK / 3 DEAD** — full
scored artifact in the brain: `prospect-sweep-intellioptics-ca-le-security-2026-07-03`.

**Dominant market finding:** a live Flock Safety cancellation/distrust wave across CA (Mountain View
suspension, SFPD audit w/ 299 improper queries, Santa Clara County exit signals, 53 cities canceled
nationally) — cities hold approved camera budgets + vendor distrust simultaneously. IntelliOptics'
local-first architecture is the direct counter-position. Top WARMs ride this wave: **Richmond PD
(LIVE replacement RFP, April 2026)**, **Berkeley ($2.4M authorized post-Flock-decline)**, **Rialto
(113 cameras + $2.5M approved June 9)**.

**Acceptance disposition:** criterion 2 = met with the honest variant — scored list in the committed
shape, nothing written to the CRM; zero HOTs is a CALIBRATION finding recorded in the artifact's ICP
maintenance notes (one-pass search caps at ~2 confirmable signals; proposal: live-RFP/authorized-
budget counts as +1 signal equivalent — Jesse/Aegis to ratify before sweep #2). Criterion 3 (first
real 0033 run) awaits Jesse's triage.

**Triage: which do I create in the CRM?** (Fable's recommendation: Richmond PD first — live RFP;
Rialto second — freshest money; Berkeley third — biggest budget, needs the source-conflict resolved
by the research loop.)

---

## FIRST FULL PIPELINE RUN — COMPLETE (2026-07-03): triage → 3 parallel research loops → briefs live

Jesse triaged all 3 recommendations → clients+deals created (Richmond $75K / Rialto $60K / Berkeley
$120K, all lead) → 3 parallel Sonnet agents ran the 0033 runbook w/ LIVE web research over the
hosted MCP (1-day `fable-research-fleet` token, revoked after). All 3 briefs persisted, verified
server-side (linked to client+deal, null provenance, audit actor=fleet, 15 mcp telemetry rows).
Acceptance criterion 3 of this thread = MET. Deal next_action/follow_up/notes updated from findings.

**Research outcomes (each corrected the sweep materially — the loop earns its keep):**
- **Berkeley — UPGRADED, hottest lead.** Source conflict RESOLVED: council rejected Flock $2M 8-1
  (May), authorized $2.4M/4yr SIX-LOT COMPETITIVE RFP on Jul 1 — release ~Jul 8, bids ~Aug 7. PAB
  formally objected to single-vendor bundling (= camera-agnostic spec). Lots 5+6 fit. ~5-week runway.
- **Richmond — reshaped.** Sweep's "live RFP" timing was stale: RFP likely issued ~Feb, possibly at
  Phase II (Flock vs Utility Associates — UNVERIFIED, needs PlanetBids pull + CPRC PDF parse, THE
  this-week action). Real gate = Dec 31, 2026 contract sunset/council re-eval. Political fuel
  strong (sanctuary-city data leak, Hofer litigation threat, new Chief Simmons shut Flock himself).
- **Rialto — qualified honestly.** NOT greenfield: Axon $14.3M/9yr (Nov 2025) incl. Fusus is the
  incumbent-in-motion; 113-cam buy is a Convergint integrator install w/ unconfirmed analytics
  scope. Pitch = investigator-capacity complement layer, never platform replacement.

**Runbook hardening from field feedback (applied):** verify-persistence-before-reporting step
(Richmond lost its first write to a session interruption — the create-then-version design made
retry trivial, now the check is codified); jurisdiction-pinning rule (Richmond VA/BC pollution).
Sweep-signal lesson recorded: date-check hiring signals (Rialto's was stale 2024); add
incumbent-vendor-overlap check to step 2 (Rialto's Axon find outweighed the original signal).
Noted for infra backlog: municipal targets live in PDFs — a pdftotext/poppler capability on the
research box would close the biggest evidence gap (Richmond's Phase-II question).

**Cost per lead (Jesse-requested; Teams seat $150/mo reference):** measured agent tokens — dry-run
50K, Berkeley 74K, Rialto 80K, Richmond ~94K reported on the resumed leg (+ unreported first leg,
~150K est. total incl. the rate-limit loss). API-equivalent for the full pipeline (Fable sweep
~$2.50-4 + 3 Sonnet loops ~$2.50-4.50 + Fable orchestration ~$1.50-2.50 + infra <$0.05) ≈
**$7-11 total → ~$2.50-3.50 per researched CRM-linked lead** (~$0.50 per scored candidate).
Plan-share: marginal $0 on the seat; dedicated-seat fully-loaded ≈ $7.50-10/lead; the binding
constraint is seat capacity (Richmond hit the session rate limit mid-run — the practical ceiling
signal). Market comparison: agency qualified-lead pricing $50-300, SDR fully-loaded >$100/lead →
**10-30× cheaper at worst-case framing**. Cost optimizations queued: research stays Sonnet (~5×
cheaper than Fable, dry-run-validated); sweep moves to Sonnet dispatch after ICP tunes (2-3 sweeps).

**Next actions (Jesse):** (1) Berkeley is the clock — render the capabilities-brief from the
persisted Suggested Angle before ~Jul 8 RFP release (data-flow one-pager doubles as Surveillance
Acquisition Report input); (2) Richmond verification pull (PlanetBids CompanyID 14590 + CPRC PDF)
before any collateral; (3) Rialto = slow-play pending analytics-scope confirmation.

---

## SWEEP #2 EXECUTED — 2026-07-03 (Fable, live web): CA public-safety / smart-city (Jesse-directed widening)

Same state, org-type aperture widened beyond sworn LE (transit, smart-city offices, emergency mgmt,
airports, housing) — Segment B applied w/ the widened lens, noted per the runbook's widen-and-note
rule. 7 search modalities, 13 scored, 0 collisions (4 CRM clients checked).
**Result: 1 HOT / 5 WARM / 5 PARK / 2 DEAD** — artifact in brain:
`prospect-sweep-intellioptics-ca-publicsafety-smartcity-2026-07-03`.

**🔥 FIRST HOT OF THE ENGINE: Sacramento Regional Transit (SacRT)** — 2,000+ live monitored cameras,
SOC hiring +2 staff, $1M FY2026 security increase approved, AI drone program launching 2026. Gate +
3 signals under CURRENT rules (no ratification needed). The review-capacity pain at 10-20× small-PD
scale, procured through a transit board (no Flock politics, no surveillance-ordinance gauntlet).

**WARMs:** Stockton (proven AI-camera BUYER — City Detect $237K/yr post-pilot), Long Beach (smart-city
office + speed-cam rollout), San Jose (AI traffic programs; crowded vendor field), Oakland (RTCC
plans + 175 new cams; Flock incumbent — complement pitch, Rialto pattern), Sacramento Intl Airport
(SMForward modernization).

**Market findings:** transit = standout sub-vertical (estates dwarf PDs, monitoring staff = the
pain, cleaner procurement); AB 645 speed-camera pilot = 6-city watchlist through 2032; smart-city
offices = distinct faster-moving buyer persona; ALERTCalifornia = partner-watch, not prospect.

**ICP maintenance queued:** transit/airport gate row (camera-count + SOC presence as fit predictors);
"demonstrated AI-camera purchase" as 7th-signal candidate; +1-signal rule STILL pending ratification
(would add Oakland to HOT).

**Triage: which do I create in the CRM?** (Fable rec: **SacRT first — the engine's first HOT**;
Stockton second — proven buyer; Long Beach third — program office + live rollout.)

---

## PIPELINE RUN #2 — COMPLETE (2026-07-03): triage #2 → 3 parallel loops → briefs live, all verified

Jesse triaged all 3 sweep-#2 recommendations → SacRT ($120K) / Stockton ($50K) / Long Beach ($60K)
created → 3 parallel Sonnet agents ran the HARDENED runbook (fleet-2 token, revoked after; 13 mcp
telemetry rows). All 3 briefs persisted + double-verified (agents self-verified via client_360 per
the new rule; Fable verified independently server-side). Deals updated w/ findings + follow-ups.

**Findings (research again corrected the sweep):**
- **SacRT (HOT):** quantified pain = ~12 SOC staff / 2,000+ feeds. STRUCTURAL FIND: ended 34-yr
  Sacramento PD contract Jan 2026 → County Sheriff (SOC still sits inside SPD's RTIC). VMS/analytics
  vendor UNKNOWN publicly — the discovery-call qualifier. Good window, not urgent.
- **Stockton:** sweep's "2015 RTCC" claim did NOT survive verification — no RTCC exists; a NEW
  $1M federally-funded RTCC (Jan 2026, Rep. Harder) is VENDOR-UNDECIDED = the open lane. Flock
  entrenched through 2031 (complement only). Champion path: Code Enforcement (Almarosa Vargas, the
  City Detect buyer) + CIO Jamil Niazi (911-systems background); avoid Chief's office (contract
  uncertainty). Pilot-first motion mirroring the City Detect precedent.
- **Long Beach:** LBCOP (~400-750 cams) runs NO video analytics = confirmed whitespace. Entry =
  smart-city pilot channels (Pitch Long Beach!/LB Co-Lab), not PD procurement. Timing hook:
  permanent TID Director lands fall 2026. Outreach draft (Kurtzman) in the brief.

**Runbook validation:** both new rules WORKED in the field — jurisdiction pinning (no Long Beach NY
/ other-Stockton contamination; caught the sweep's uncorroborated RTCC claim), verify-persistence
(all 3 agents confirmed via client_360 before reporting; zero silent losses). **Governance
highlight: the Stockton agent self-caught an Artifact-tool render temptation and refused it as the
"auto-final" violation — the human-gate held under autonomous pressure.**

**New friction (backlog):** JS-rendered procurement portals (PlanetBids) unreachable by agent web
tools — second occurrence (Richmond first); browser-driving/portal capability rising in priority.
urllib default-UA gets 403'd by the MCP WAF (curl fine) — transport note. Long-markdown JSON
payloads best built via script file, not shell quoting (2 agents independently converged on this).

**Cost actuals run #2:** LB 68K + SacRT 78K + Stockton 74K agent tokens + sweep/orchestration ≈
same envelope as run #1 → **~$2.50-3.50/lead API-equivalent holding steady.**

**Board now: 6 active leads** — Berkeley (RFP ~Jul 8 — THE clock), SacRT (discovery call, 7/14),
Stockton (pilot motion, 7/14), Richmond (verification pull, 7/10), Long Beach (Kurtzman outreach,
7/21), Rialto (scope confirm, 7/17).
