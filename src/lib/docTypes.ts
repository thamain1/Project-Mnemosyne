// Client-side doc-type catalog for the Create page. Mirrors functions/_lib/brand-template.ts
// DOC_TYPE_CATALOG (the server is authoritative — render-document validates doc_type). Keep ids in sync.

export type DocCategory = 'contract' | 'marketing'
export interface UiDocType { id: string; label: string; category: DocCategory; hasGenerator: boolean }

export const DOC_TYPE_CATALOG: UiDocType[] = [
  { id: 'mou', label: 'Memorandum of Understanding', category: 'contract', hasGenerator: true },
  { id: 'sow', label: 'Statement of Work', category: 'contract', hasGenerator: true },
  { id: 'proposal', label: 'Proposal', category: 'contract', hasGenerator: false },
  { id: 'invoice', label: 'Invoice', category: 'contract', hasGenerator: false },
  { id: 'change-order', label: 'Change Order', category: 'contract', hasGenerator: false },
  { id: 'white-paper', label: 'White Paper', category: 'marketing', hasGenerator: false },
  { id: 'use-case', label: 'Use Case', category: 'marketing', hasGenerator: false },
  { id: 'capabilities-brief', label: 'Capabilities Brief', category: 'marketing', hasGenerator: false },
  { id: 'exec-briefing', label: 'Executive Briefing', category: 'marketing', hasGenerator: false },
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
  // marketing
  return `{{block:logo}}

# ${title}

## Summary

[One-paragraph summary.]

## Section

[Body content. Markdown: **bold**, lists, tables, and [links](https://4wardmotions.com) are supported.]
`
}
