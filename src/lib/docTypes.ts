// Client-side doc-type catalog for the Create page. Mirrors functions/_lib/brand-template.ts
// DOC_TYPE_CATALOG (the server is authoritative — render-document validates doc_type). Keep ids in sync.

export type DocCategory = 'contract' | 'marketing'
export type DocAudience = 'client' | 'internal'
export interface UiDocType { id: string; label: string; category: DocCategory; allowedAudiences: DocAudience[]; hasGenerator: boolean }

export const DOC_TYPE_CATALOG: UiDocType[] = [
  { id: 'mou', label: 'Memorandum of Understanding', category: 'contract', allowedAudiences: ['client', 'internal'], hasGenerator: true },
  { id: 'sow', label: 'Statement of Work', category: 'contract', allowedAudiences: ['client', 'internal'], hasGenerator: true },
  { id: 'proposal', label: 'Proposal', category: 'contract', allowedAudiences: ['client', 'internal'], hasGenerator: false },
  { id: 'invoice', label: 'Invoice', category: 'contract', allowedAudiences: ['client', 'internal'], hasGenerator: false },
  { id: 'change-order', label: 'Change Order', category: 'contract', allowedAudiences: ['client', 'internal'], hasGenerator: false },
  { id: 'white-paper', label: 'White Paper', category: 'marketing', allowedAudiences: ['client', 'internal'], hasGenerator: false },
  { id: 'use-case', label: 'Use Case', category: 'marketing', allowedAudiences: ['client', 'internal'], hasGenerator: false },
  { id: 'capabilities-brief', label: 'Capabilities Brief', category: 'marketing', allowedAudiences: ['client', 'internal'], hasGenerator: false },
  { id: 'exec-briefing', label: 'Executive Briefing', category: 'marketing', allowedAudiences: ['client', 'internal'], hasGenerator: false },
  { id: 'case-study', label: 'Case Study', category: 'marketing', allowedAudiences: ['client', 'internal'], hasGenerator: false },
  // internal ONLY — the client audience option is structurally omitted, not just hidden (see Create.tsx)
  { id: 'client-brief', label: 'Client Brief (internal)', category: 'marketing', allowedAudiences: ['internal'], hasGenerator: false },
]

export const docTypeById = (id: string) => DOC_TYPE_CATALOG.find((d) => d.id === id)

// Per-type starter markdown. Uses the TRUSTED render tokens ({{block:logo}}, {{block:signature ...}}) that the
// render core expands — raw HTML in markdown is escaped, so the logo/signature MUST come from these tokens.
export function starterFor(id: string): string {
  const t = docTypeById(id)
  const title = t?.label ?? 'Document'
  const sig = '\n\n{{block:signature | entity=[Client legal entity] | name=[Signatory name] | title=[Title]}}'
  if (t?.category === 'contract') {
    return `{{block:logo}}

# ${title}

**Client:** [Client legal entity]
**Effective Date:** [Date of last signature]
**Reference:** [REF-2026-001]

---

## 1. Overview

[Describe the engagement.]

## 2. Details

[Scope, terms, amounts — fill in.]
${sig}

---

*Draft for review — confirm every bracketed item before signature. Not legal advice.*
`
  }
  if (id === 'case-study') {
    return `{{block:logo}}

# Case Study

## Client & Context

[Who the client is, industry, size — set the scene.]

## Challenge

[The problem before 4ward got involved.]

## What We Built

[The solution — plain-language, outcome-oriented, not a feature list.]

## Outcome (metrics)

[Concrete before/after numbers — time saved, revenue, error rate, etc.]

## Pull Quote

> [A short client quote, if available.]

## About 4ward

[One paragraph, boilerplate.]
`
  }
  if (id === 'client-brief') {
    return `{{block:logo}}

# Client Research Brief — INTERNAL ONLY

## Company Snapshot

[Size, industry, recent news, funding/ownership.]

## People

[Key decision-makers, roles, background.]

## Signals — Why Now

[What suggests this is a good moment to reach out.]

## Fit vs 4ward Capabilities

[Where our capabilities map to their likely needs.]

## Suggested Angle

[The opening/positioning to use.]

## Draft Outreach (DRAFT — NEVER SEND FROM HERE)

[Draft text only. This brief is never emailed or sent as-is.]

## Sources

[Links/citations for every claim above.]
`
  }
  // marketing
  return `{{block:logo}}

# ${title}

## Summary

[One-paragraph summary.]

## Section

[Body content. Markdown: **bold**, lists, tables, and [links](https://4wardmotions.com) are supported.]
`
}
