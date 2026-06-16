// Client-side, RENDER-ONLY slot spec for the Generate page. Mirrors the authoritative spec in
// functions/_lib/contract-templates.ts (SLOTS) — the FUNCTION validates and rejects unknown/oversize/missing
// fields, so this copy only drives form rendering. Keep field keys + kinds + required flags in sync with it.

export const DOC_TYPES = [
  { value: 'mou', label: 'MOU — Memorandum of Understanding' },
  { value: 'sow', label: 'SOW — Statement of Work' },
] as const
export type DocType = 'mou' | 'sow'

export type UiSlot = {
  key: string
  kind: 'fill' | 'draft'
  required: boolean
  label: string
  help: string
  multiline?: boolean
}

const SHARED: UiSlot[] = [
  { key: 'project_name', kind: 'fill', required: true, label: 'Project / engagement name', help: 'e.g. "Acme Member Portal — Launch Core"' },
  { key: 'client_entity', kind: 'fill', required: true, label: 'Client legal entity', help: 'Full legal name + entity type/state, or an individual' },
  { key: 'client_address', kind: 'fill', required: false, label: 'Client address', help: 'Registered business / mailing address', multiline: true },
  { key: 'client_attn', kind: 'fill', required: true, label: 'Client contact (Attn)', help: 'Name, and title if known' },
  { key: 'client_email', kind: 'fill', required: false, label: 'Client email', help: 'Primary contact email' },
  { key: 'client_signatory_name', kind: 'fill', required: true, label: 'Client signatory name', help: 'Who signs for the client' },
  { key: 'client_signatory_title', kind: 'fill', required: false, label: 'Client signatory title', help: 'Signatory title' },
  { key: 'effective_date', kind: 'fill', required: false, label: 'Effective date', help: 'Leave blank for "date of last signature"' },
  { key: 'engagement_ref', kind: 'fill', required: true, label: 'Engagement reference', help: 'e.g. "ACM-2026-001"' },
  { key: 'sow_ref', kind: 'fill', required: true, label: 'SOW reference', help: 'e.g. "ACM-SOW-001 — Acme Portal"' },
  { key: 'hourly_rate', kind: 'fill', required: false, label: 'Hourly rate (out-of-scope)', help: 'Default $195' },
]

export const SLOTS: Record<DocType, UiSlot[]> = {
  mou: [
    ...SHARED,
    { key: 'markup_pct', kind: 'fill', required: false, label: 'Third-party markup %', help: 'Default fifteen percent (15%)' },
    { key: 'usage_notice_threshold', kind: 'fill', required: false, label: 'Usage-notice threshold', help: 'Default US $500' },
    { key: 'support_period', kind: 'fill', required: false, label: 'Support period', help: 'Default thirty (30) calendar days' },
    { key: 'timeline', kind: 'fill', required: true, label: 'Delivery timeline', help: 'e.g. "eight (8) weeks"' },
    { key: 'milestones_table', kind: 'fill', required: true, label: 'Milestone schedule (markdown table)', help: '| # | Milestone | Trigger | Amount | rows + a Total', multiline: true },
    { key: 'fee_summary', kind: 'draft', required: true, label: 'Fee summary (§3.1)', help: 'Total fee, any discount, what the Project Fee includes' },
    { key: 'purpose', kind: 'draft', required: true, label: 'Purpose (§1)', help: 'What is being built and for whom' },
    { key: 'scope_summary', kind: 'draft', required: true, label: 'Scope summary (§2 bullets)', help: 'Headline capabilities (becomes a bulleted list)' },
    { key: 'managed_service', kind: 'draft', required: false, label: 'Managed-service tiers (§6)', help: 'Tier names, monthly fees, what each includes (becomes a table)' },
    { key: 'client_responsibilities', kind: 'draft', required: true, label: 'Client responsibilities (§9)', help: 'What the client must provide (becomes a lettered list)' },
    { key: 'future_phases', kind: 'draft', required: false, label: 'Future phases (§12.2)', help: 'Representative out-of-scope future capabilities (becomes bullets)' },
  ],
  sow: [
    ...SHARED,
    { key: 'overview', kind: 'draft', required: true, label: 'Project overview (§2)', help: 'What 4ward will build and deliver, and for whom' },
    { key: 'deliverables', kind: 'draft', required: true, label: 'Deliverables (§3)', help: 'Feature areas to deliver (becomes grouped sub-sections with bullets)' },
    { key: 'acceptance', kind: 'draft', required: true, label: 'Acceptance criteria (§4)', help: 'Testable conditions for acceptance (becomes a numbered list)' },
    { key: 'out_of_scope', kind: 'draft', required: true, label: 'Out of scope (§5)', help: 'What is explicitly excluded (becomes a bulleted list)' },
    { key: 'client_responsibilities', kind: 'draft', required: true, label: 'Client responsibilities (§6.2)', help: 'What the client must provide/do (becomes a bulleted list)' },
    { key: 'assumptions', kind: 'draft', required: false, label: 'Assumptions & dependencies (§7)', help: 'Scoping assumptions (becomes a numbered list)' },
  ],
}
