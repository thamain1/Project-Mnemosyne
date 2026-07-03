# Runbook — Prospect Research Loop (P2-LOOP v1, thread 0033)

**Dispatch line:** "Read `docs/runbooks/prospect-research.md`; research \<lead\>."

This is the committed procedure an agent session (operator or a hosted-MCP machine with the
`client_brief`/`client_360`/`recall`/`fetch`/`brief` scopes) executes end-to-end for one prospect.
Mnemosyne's job in this loop is grounding, durable client-linked persistence, and branded output —
**not** sending anything. Read the hard rules below before you start; they are not optional.

## Hard rules

1. **No outreach is ever sent from this loop.** Step 4's "Draft Outreach" section is text only,
   clearly marked DRAFT, for a human to review and send from their own tools. There is no email/
   LinkedIn-sending capability in this unit, on purpose (P2-DRAFT posture — drafting only, forever,
   until a dedicated deliverability unit exists).
2. **No client auto-creation.** If the client doesn't exist in the CRM yet, `client_brief` will
   report "client not found" — report this back to the human and stop. A human creates the client via
   the CRM tab first (this is a deliberate one-writer-shape rule for the `clients` table).
3. **Secret-scan is not optional.** `client_brief` refuses to store any text matching a known secret
   pattern (API keys, tokens, connection strings). If research legitimately surfaces something that
   trips the scanner (rare), redact it before calling the tool — never work around the refusal.
4. **Never guess a client or deal.** If `client` or `deal` resolves to more than one candidate, the
   tool returns/throws the candidate list — pick the right one and retry with the exact name or uuid.
   Don't pick one arbitrarily.

## The loop

### 1. GROUND

Before researching anything, pull what the brain already knows:

- `client_360({ client: "<name or uuid>" })` — if the client already exists in the CRM, this returns
  contacts, deals, linked memories, linked documents, and recent activity in one call. If it returns
  `{ error: "not_found", candidates: [] }`, the client doesn't exist yet — note this for step 5 (a
  human must create it first) and continue with steps 2-4 anyway; you can still ground on general
  recall.
- `recall({ query: "<lead/company name>", client_id: "<uuid, if known from client_360>" })` — hybrid
  (vector + full-text) search scoped to this client if it exists, otherwise unscoped.
- `brief({ project: "<related project, if any>" })` — only if this research ties to an existing
  4ward project/engagement.

### 2. RESEARCH

This is agent-side work — use your own web research tools (Mnemosyne is not a crawler and has no
scraping infrastructure in this unit). Cover, at minimum:

- **Company**: what they do, size, industry, recent news/funding.
- **People**: decision-makers relevant to a 4ward engagement — name, role, background.
- **Signals — why now**: anything suggesting this is a good moment to reach out (a hire, a launch, a
  funding round, a public pain point).
- **Tech surface**: anything publicly visible about their stack/tooling that's relevant to fit.

**Every non-obvious claim needs a source citation in the brief body.** A brief with no sources is not
acceptable output from this loop — write "Sources: [links]" as its own section.

### 3. PERSIST

Write the research into the brain, linked to the client:

```
client_brief({
  client: "<name or uuid — from step 1, or the raw name if the client doesn't exist yet>",
  title: "Client Brief — <Company> — <YYYY-MM-DD>",
  body: "<the full research brief in markdown — Company Snapshot / People / Signals-Why-Now / Fit vs
         4ward Capabilities / Suggested Angle / Draft Outreach / Sources>",
  deal: "<optional — a deal title or uuid, scoped to this client, if one already exists>",
})
```

- First call for a client **creates** the memory (`refreshed: false`); a later call for the **same**
  client **updates** it in place and versions the prior body (`refreshed: true`) — safe to re-run the
  loop on the same lead as research deepens.
- If `client` doesn't resolve (not found or ambiguous), **stop here** and report back to the human —
  do not proceed to step 4 without a linked client (there'd be nothing to attach the deal/collateral
  to later).
- On success, the brief is immediately visible in `client_360`, in `recall` with a `client_id` filter,
  and as a bridge edge in the Memories graph.

### 4. DRAFT

Using client_360 + the recall hits + the brief you just wrote as grounding, draft **markdown-only**
collateral for the human to review — do not render or save it yourself (see Non-goals below):

- A **case-study** framing (if there's a relevant past 4ward engagement to point to) or a
  **capabilities-brief**-style pitch grounded specifically in what you learned about this lead.
- Keep the "Suggested Angle" and "Draft Outreach" sections from the persisted brief as the anchor —
  don't invent a new pitch disconnected from what's already been written to the brain.

### 5. HANDOFF

Report back to the human (Jesse, or whoever dispatched the loop) with:

- What was found and persisted (the `client_brief` name/refreshed status).
- Whether the client needs to be created first (if step 1/3 hit "not found").
- What to render: which doc type (`case-study` or `client-brief`) and suggested title.
- What deal to attach it to, if any (or "no deal yet — create one in the CRM if this progresses").

**Rendering and saving are human-gated** — the human uses the Create tab (Create > pick doc type >
paste/adapt the draft > Render/Save). An agent publishing collateral unreviewed is exactly the
"auto-final" failure the Document Factory's design forbids. `client-brief`-type documents are
internal-only by construction (the client audience option does not exist for that type) — a
capabilities-brief or case-study derived from the research is what actually goes to the client.

## Non-goals (v1) — do not attempt these from this loop

- Sending anything (email/LinkedIn) — ever, from this tool. Draft text only.
- Rendering or saving a document yourself — that's the human's Create-tab step.
- Auto-creating a CRM client — report back and stop.
- Scraping/crawling infrastructure — your own research tools are the "crawler."
