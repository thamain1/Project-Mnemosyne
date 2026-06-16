// Mnemosyne — Sales Factory C4.1: GOVERNED contract templates (MOU + SOW).
//
// THE GOVERNANCE BOUNDARY. A generated contract is assembled from three kinds of content:
//   1. CONSTANTS — the literal text in the skeletons below (logo block, 4ward party block, IP /
//      confidentiality / warranty / liability / termination / governing-law / notices clauses, signature
//      block). The model NEVER produces or alters these. They are pasted verbatim every time → this is what
//      makes output repeatable and legally consistent, and is why generation is safe to expose internally.
//   2. {{fill}} slots — deterministic string substitution from the caller's structured form fields
//      (parties, dates, references, fee amounts, the milestone table, timeline, markup %, signatory). No
//      model involvement.
//   3. {{draft::key}} slots — the ONLY content the model writes: deal-specific narrative (purpose, scope,
//      deliverables, acceptance criteria, out-of-scope), drafted from a short brief and grounded on the
//      closest same-type exemplar already in the brain. The model cannot touch anything outside these.
//
// Standing rules baked in: entity = "4ward Motion Solutions, Inc." (Delaware corporation); governing law +
// venue = Delaware; Jesse signs as "Co-Founder and CTO"; NO third-party vendor names in client-facing text
// (functional categories only — "managed database platform", not a brand); NO AI-disclosure language in
// binding docs. Drafts are an assisted-drafting aid for Jesse's review — never auto-final, never auto-sent.

export type SlotKind = 'fill' | 'draft'
export type SlotSpec = {
  key: string
  kind: SlotKind
  required: boolean
  label: string
  help: string
  max: number          // max chars (fill: the rendered value; draft: the model output)
  default?: string     // optional default for fill slots when omitted
  multiline?: boolean  // UI hint for fill slots
}

export const DOC_TYPES = ['mou', 'sow'] as const
export type DocType = (typeof DOC_TYPES)[number]

// The 4ward party block + logo are constant across every document.
const LOGO_BLOCK = `<p align="center">
  <img src="./4ward-motion-logo.png" alt="4ward Motion" width="240" />
</p>`

const FOURWARD_PARTY = `**4ward Motion Solutions, Inc.**, a Delaware corporation ("4ward")
2810 N Church St, #430080
Wilmington, DE 19802
Attn: Jesse Morgan, Co-Founder and CTO
Email: jmorgan@4wardmotions.com`

const FOURWARD_SIGNATURE = `<div class="signature-block">
    <p class="signature-party"><strong>4ward Motion Solutions, Inc.</strong></p>
    <p><span class="signature-label">By:</span><span class="signature-line"></span></p>
    <p><span class="signature-label">Name:</span>Jesse Morgan</p>
    <p><span class="signature-label">Title:</span>Co-Founder and CTO</p>
    <p><span class="signature-label">Date:</span><span class="date-line"></span></p>
  </div>`

// ─────────────────────────────────────────────────────────────────────────────
// MOU
// ─────────────────────────────────────────────────────────────────────────────
export const MOU_SKELETON = `${LOGO_BLOCK}

# MEMORANDUM OF UNDERSTANDING

**Project:** {{project_name}}
**Effective Date:** {{effective_date}}
**Engagement Reference:** {{engagement_ref}}

---

## Parties

**Service Provider:**
${FOURWARD_PARTY}

**Client:**
**{{client_entity}}**
{{client_address}}
Attn: {{client_attn}}
Email: {{client_email}}

4ward and Client are each a "Party" and together the "Parties."

---

## 1. Purpose

{{draft::purpose}}

---

## 2. Scope of Work

4ward will design, build, configure, and deliver the work substantially as described in the **Statement of Work, reference {{sow_ref}}** (the "SOW"), executed by the Parties and incorporated into this MOU by reference.

The engagement is designed to help Client:

{{draft::scope_summary}}

Anything not expressly included in the SOW is out of scope and subject to Section 12 (Change Control).

---

## 3. Project Fee and Payment

### 3.1 Total Fixed Fee

{{draft::fee_summary}}

### 3.2 Milestone Schedule

The Project Fee is payable per the following schedule:

{{milestones_table}}

### 3.3 Payment Terms

The M1 invoice is **due on receipt**. 4ward will not commence work, establish Third-Party Service accounts under Section 4, or incur any Third-Party Service charges on Client's behalf until the M1 amount has been paid in full and the funds have been received in 4ward's account.

Subsequent invoices and all Third-Party Pass-Through invoices under Section 4 are payable **net ten (10) days** from the invoice date. Late payments accrue interest at one and one-half percent (1.5%) per month or the maximum rate permitted by law, whichever is less. If any invoice remains unpaid more than ten (10) days past its due date, 4ward may, on written notice, suspend further work until the past-due amount is paid in full.

### 3.4 Form of Payment

Client shall remit payment by the method specified on each invoice. Payment instructions will be provided with the M1 invoice.

---

## 4. Third-Party Service Costs

### 4.1 Account Ownership

The work depends on third-party cloud services, which may include (without limitation) a managed database, authentication, and file-storage platform; a transactional email delivery provider; a web hosting and content-delivery platform; and a payment processor (collectively, the "Third-Party Services"). During the engagement, 4ward will establish and maintain the Third-Party Service accounts required to build, test, and operate the deliverables, except that any payment-processing account will be established in Client's name from the outset where revenue settles to Client.

### 4.2 Pass-Through Billing with Administrative Markup

4ward will invoice Client monthly, in arrears, for the actual third-party charges incurred for Client's benefit during the prior calendar month plus a {{markup_pct}} administrative markup ("Third-Party Pass-Through"). Each Third-Party Pass-Through invoice will itemize the underlying services and amounts and is payable **net ten (10) days** from the invoice date.

### 4.3 Usage Notice

If 4ward reasonably anticipates that any single monthly Third-Party Pass-Through invoice will exceed **{{usage_notice_threshold}}**, 4ward will notify Client in writing in advance and obtain Client approval before continuing to incur the excess charges, except where the excess results directly from Client's own use of the deliverables.

### 4.4 Account Transfer

At the conclusion of the Support Period in Section 5 — or, if Client elects an ongoing managed service tier under Section 6, upon termination of that service — 4ward will reasonably cooperate to transfer ownership of the Third-Party Service accounts to Client or a successor provider designated by Client. Continued operation after such transfer is Client's responsibility.

### 4.5 Client Sole Responsibility for Compliance

Client is solely responsible for compliance with all laws, regulations, and third-party terms applicable to Client's operation of the deliverables and Client's business. 4ward will implement the controls described in the SOW but does not provide legal advice or regulatory compliance certification.

---

## 5. Post-Acceptance Support

### 5.1 Included Support Period

For {{support_period}} following the Acceptance Date (the "Support Period"), 4ward will, at no additional professional services fee, correct defects in the delivered features that materially deviate from the Acceptance Criteria, make minor textual or visual adjustments (each reasonably estimated at four (4) hours of effort or less), and provide reasonable assistance with configuration questions.

### 5.2 Excluded From Support

New features, integrations, or modules not delivered under this MOU; content authoring beyond any sample delivered under the SOW; changes required by Client adoption of additional Third-Party Services; changes required by a Third-Party Service provider's policy, pricing, or API changes; deliverability remediation beyond initial configuration; training beyond the initial handoff; and data import or migration are out of scope of the Support Period and require a separate engagement, change request, or managed service tier under Section 6.

### 5.3 Response Targets

During the Support Period, 4ward will use commercially reasonable efforts to acknowledge support requests within one (1) business day and to commence remediation of confirmed defects within three (3) business days. These are good-faith targets, not warranties.

---

## 6. Optional Ongoing Managed Service

Following the Acceptance Date, Client may elect an ongoing managed service tier. Tier election is optional, separately invoiced monthly in advance, and is not a condition of this MOU. Tier changes or cancellation require thirty (30) days' written notice.

{{draft::managed_service}}

Out-of-scope or above-tier development work is billed at **{{hourly_rate}} per hour**, with a written estimate provided and Client's written authorization obtained before work begins.

---

## 7. Acceptance

The deliverables will be considered ready for Client acceptance when they satisfy the acceptance criteria set forth in the SOW (the "Acceptance Criteria"). Upon 4ward's written notice that the deliverables are ready, Client will have ten (10) business days (the "Acceptance Review Period") to test against the Acceptance Criteria and provide written notice of either (a) acceptance, or (b) specific, good-faith deficiencies relative to the Acceptance Criteria. If Client does not deliver written acceptance or a written deficiency notice within the Acceptance Review Period, the deliverables are deemed accepted on the final day of that period. If Client identifies deficiencies, 4ward will use commercially reasonable efforts to remediate them and re-tender; the Acceptance Review Period restarts upon each re-tender. The date of acceptance (express or deemed) is the "Acceptance Date," which triggers the final invoice (Section 3.2) and starts the Support Period (Section 5).

---

## 8. Timeline

The Parties anticipate that the deliverables will be delivered for acceptance approximately **{{timeline}}** after the later of the Effective Date and receipt of the M1 amount, subject to Client timely meeting its responsibilities in Section 9. If Client fails to deliver any required input, approval, account access, content, or feedback within ten (10) business days of 4ward's written request, 4ward may, at its election, pause the project timeline and milestone schedule until the delay is cured. A Client delay does not constitute breach by 4ward and does not reduce the Project Fee.

---

## 9. Client Responsibilities

Client agrees to:

{{draft::client_responsibilities}}

---

## 10. 4ward Responsibilities

4ward agrees to (a) perform the work described in the SOW with reasonable skill and care; (b) implement the safeguards described in the SOW; (c) provide reasonable handoff documentation describing the deliverables and their administration; and (d) notify Client of material risks, limitations, or recommended future improvements identified during the engagement.

---

## 11. Intellectual Property and Data Ownership

### 11.1 Delivered Code

Upon Client's payment of the full Project Fee, 4ward assigns to Client all right, title, and interest in the delivered source code, **excluding** Pre-Existing IP (defined below). Client may use, modify, and host the delivered code without further obligation to 4ward, subject to the licenses governing the Third-Party Services and any open-source components used.

### 11.2 Pre-Existing IP

4ward retains all right, title, and interest in (a) any 4ward general-purpose libraries, templates, frameworks, methodologies, or development tooling that pre-existed this engagement or are developed by 4ward for general use, and (b) any future enhancements thereto ("Pre-Existing IP"). To the extent any Pre-Existing IP is incorporated into the delivered work, 4ward grants Client a perpetual, non-exclusive, royalty-free license to use such Pre-Existing IP solely as embedded in the delivered work.

### 11.3 Client Data and Content

All data uploaded to, generated by, or maintained within the deliverables by Client, by Client's users, or on Client's behalf is Client's data ("Client Data"). 4ward claims no ownership of Client Data and will return or, at Client's election, securely destroy Client Data in 4ward's possession at the end of any post-engagement transition.

### 11.4 No License to Marks

Nothing in this MOU grants either Party rights in the other Party's name, marks, or branding, except for the limited purpose of performing under this MOU.

---

## 12. Change Control and Future Phases

### 12.1 Change Orders

Any work not expressly included in the SOW is out of scope. Either Party may propose a change in writing. A change becomes binding only upon a written change order signed by both Parties identifying the scope, schedule, and price impact.

### 12.2 Future Phases

This engagement delivers the scope described in the SOW. Representative capabilities that are out of scope and may be discussed by the Parties for a future phase include, without limitation:

{{draft::future_phases}}

Any such future-phase work will require a separate written agreement before 4ward will perform any related work. Neither Party is obligated to enter into any such future agreement, and the rates, fees, timing, and other terms of any future phase will be negotiated separately at that time.

---

## 13. Confidentiality

Each Party may receive non-public business, technical, financial, or operational information of the other Party in connection with this engagement ("Confidential Information"). Each Party will use the other Party's Confidential Information solely to perform under this MOU, will protect it with at least the same care it uses for its own confidential information (and in any event no less than reasonable care), and will not disclose it to third parties except to its employees, contractors, and agents with a need to know who are bound by confidentiality obligations no less protective than these. Confidential Information does not include information that (a) is or becomes public through no fault of the receiving Party, (b) was rightfully known to the receiving Party without restriction prior to disclosure, (c) is independently developed without reference to the disclosing Party's Confidential Information, or (d) is rightfully obtained from a third party without restriction. The receiving Party may disclose Confidential Information to the extent required by law, court order, or governmental authority, provided it gives reasonable advance notice to the disclosing Party where lawfully permitted.

---

## 14. Warranties and Disclaimers

4ward warrants that the services provided under this MOU will be performed in a professional and workmanlike manner consistent with generally accepted industry practices. EXCEPT AS EXPRESSLY STATED IN THE PRECEDING SENTENCE, THE DELIVERABLES AND ALL SERVICES ARE PROVIDED "AS IS" AND "AS BUILT." 4WARD DISCLAIMS ALL OTHER WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, UNINTERRUPTED OPERATION, AND ERROR-FREE OPERATION. 4ward makes no warranty with respect to any Third-Party Service; Third-Party Services are governed by their respective providers' terms, and their availability, pricing, features, and policies are outside 4ward's control. 4ward does not provide legal advice or regulatory compliance certification.

---

## 15. Limitation of Liability

EXCEPT FOR (a) A PARTY'S BREACH OF CONFIDENTIALITY OBLIGATIONS UNDER SECTION 13, (b) CLIENT'S PAYMENT OBLIGATIONS, AND (c) LIABILITY THAT CANNOT BE LIMITED UNDER APPLICABLE LAW, EACH PARTY'S TOTAL CUMULATIVE LIABILITY ARISING OUT OF OR RELATED TO THIS MOU WILL NOT EXCEED THE TOTAL PROJECT FEE ACTUALLY PAID BY CLIENT TO 4WARD UNDER THIS MOU. IN NO EVENT WILL EITHER PARTY BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, PUNITIVE, OR EXEMPLARY DAMAGES, OR FOR LOST PROFITS, LOST REVENUE, LOST DATA, OR LOSS OF BUSINESS OPPORTUNITY, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

---

## 16. Term and Termination

This MOU commences on the Effective Date and continues through the latest of (a) the end of the Support Period, (b) termination of any elected Section 6 managed service tier, or (c) the date both Parties have performed all then-outstanding obligations, unless earlier terminated. Either Party may terminate for convenience on fifteen (15) days' written notice, in which case 4ward will deliver work product completed through the effective termination date and Client will pay 4ward for all milestones already achieved plus any Third-Party Pass-Through and managed-service amounts incurred through that date. Either Party may terminate immediately on written notice if the other Party (a) materially breaches this MOU and fails to cure within fifteen (15) days after written notice, or (b) becomes insolvent, makes an assignment for the benefit of creditors, or is the subject of a bankruptcy proceeding not dismissed within sixty (60) days. Sections 4.5, 11, 13, 14, 15, and 18 survive termination.

---

## 17. Independent Contractor

4ward is an independent contractor. Nothing in this MOU creates an employer-employee relationship, partnership, joint venture, or agency between the Parties.

---

## 18. Governing Law; Venue; Dispute Resolution

This MOU is governed by the laws of the State of Delaware, without regard to its conflict-of-laws principles. The Parties consent to exclusive jurisdiction and venue in the state and federal courts located in Delaware for any dispute that cannot be resolved by good-faith negotiation between the Parties.

---

## 19. Notices

All formal notices under this MOU must be in writing and sent (a) by email to the addresses listed for each Party at the top of this MOU, with confirmation of delivery, or (b) by recognized overnight courier to the physical addresses listed for each Party. Notice is effective on the next business day after sending by email (if confirmation is received) or one business day after delivery confirmation by courier.

---

## 20. Entire Agreement; Amendments; Assignment

This MOU, together with the SOW, is the entire agreement of the Parties regarding the engagement and supersedes any prior or contemporaneous proposals, communications, or understandings. Any amendment must be in writing and signed by authorized representatives of both Parties. Neither Party may assign this MOU without the other Party's prior written consent, except that 4ward may assign this MOU to a successor entity in connection with a merger, reorganization, or sale of substantially all of its assets.

---

## 21. Signatures

The Parties execute this MOU as of the Effective Date.

<div class="signature-grid">
  ${FOURWARD_SIGNATURE}
  <div class="signature-block">
    <p class="signature-party"><strong>{{client_entity}}</strong></p>
    <p><span class="signature-label">By:</span><span class="signature-line"></span></p>
    <p><span class="signature-label">Name:</span>{{client_signatory_name}}</p>
    <p><span class="signature-label">Title:</span>{{client_signatory_title}}</p>
    <p><span class="signature-label">Date:</span><span class="date-line"></span></p>
  </div>
</div>

---

*End of MOU. This is a draft for review — confirm all bracketed items, figures, and party details before signature.*
`

// ─────────────────────────────────────────────────────────────────────────────
// SOW
// ─────────────────────────────────────────────────────────────────────────────
export const SOW_SKELETON = `${LOGO_BLOCK}

# Statement of Work

**Project:** {{project_name}}
**Between:** 4ward Motion Solutions, Inc., a Delaware corporation ("**4ward**")
**And:** {{client_entity}} ("**Client**")
**Point of Contact (Client):** {{client_attn}}
**Effective Date:** {{effective_date}}
**SOW Reference:** {{sow_ref}}

---

## 1. Relationship to MOU

This Statement of Work ("**SOW**") is issued under and governed by the Memorandum of Understanding between the parties, reference {{engagement_ref}} (the "**MOU**"). The MOU controls on all commercial terms (fees, payment schedule, third-party costs, support, managed-service tiers, intellectual property, confidentiality, termination, governing law). This SOW controls on technical scope, deliverables, acceptance criteria, timeline, and operating responsibilities. Where this SOW and the MOU conflict on a commercial point, the MOU controls; where they conflict on a scope point, this SOW controls. Capitalized terms used and not defined here have the meanings given in the MOU.

## 2. Project Overview

{{draft::overview}}

Specific vendor selections, component architecture choices, and implementation details within 4ward's managed-infrastructure stack are within 4ward's professional discretion.

## 3. Deliverables

{{draft::deliverables}}

## 4. Acceptance Criteria

The deliverables are ready for acceptance under MOU §7 when all of the following pass:

{{draft::acceptance}}

## 5. Out of Scope

The following are not included in this engagement and, if required, must be added via a Change Order under §8 or a future-phase agreement under MOU §12.2:

{{draft::out_of_scope}}

## 6. Roles and Responsibilities

### 6.1 4ward Responsibilities

- Furnish the team and perform the work in §3 with reasonable skill and care.
- Provision and operate engagement infrastructure under the account-ownership arrangement in MOU §4.
- Implement and maintain the safeguards described in §3.
- Provide the documentation, training materials, and handoff items described in §3.

### 6.2 Client Responsibilities

{{draft::client_responsibilities}}

## 7. Assumptions and Dependencies

This SOW is scoped and priced on the following assumptions; material deviations may require a Change Order under §8:

{{draft::assumptions}}

## 8. Change Orders

Any change to scope, deliverables, acceptance criteria, timeline, or fees requires a **written Change Order** signed by both parties' authorized signatories. Change Orders may be executed via email confirmation between Jesse Morgan (for 4ward) and Client's designated decision-maker. Out-of-scope work is billed at **{{hourly_rate}} per hour**, invoiced monthly, net 10. 4ward will provide a written estimate before commencing any out-of-scope work and will not proceed without Client's written authorization (email sufficient).

## 9. Conflict Resolution

In case of any conflict between this SOW and the MOU, the MOU governs commercial terms and this SOW governs scope and acceptance. In the case of remaining ambiguity, the parties will negotiate in good faith per MOU §18.

## 10. Effective Period

This SOW takes effect on the Effective Date above and remains in effect until the later of (a) the Acceptance Date under MOU §7, or (b) expiration of the Support Period under MOU §5. Any ongoing managed-service relationship after that point is governed by the tier election under MOU §6.

---

## Signatures

**4ward Motion Solutions, Inc.**

Signature: ______________________________
Name: Jesse Morgan
Title: Co-Founder and CTO
Date: ___________________________________

**{{client_entity}}**

Signature: ______________________________
Name: {{client_signatory_name}}
Title: {{client_signatory_title}}
Date: ___________________________________
`

// ─────────────────────────────────────────────────────────────────────────────
// Slot specs (per doc type). Shared fill slots (parties/refs/dates) appear in both.
// ─────────────────────────────────────────────────────────────────────────────
const SHARED_FILL: SlotSpec[] = [
  { key: 'project_name', kind: 'fill', required: true, label: 'Project / engagement name', help: 'e.g. "Acme Member Portal — Launch Core"', max: 200 },
  { key: 'client_entity', kind: 'fill', required: true, label: 'Client legal entity', help: 'Full legal name + entity type/state, or an individual', max: 200 },
  { key: 'client_address', kind: 'fill', required: false, label: 'Client address', help: 'Registered business / mailing address', max: 200, default: '[Client business address]', multiline: true },
  { key: 'client_attn', kind: 'fill', required: true, label: 'Client contact (Attn)', help: 'Name, and title if known', max: 120 },
  { key: 'client_email', kind: 'fill', required: false, label: 'Client email', help: 'Primary contact email', max: 120, default: '[Client email]' },
  { key: 'client_signatory_name', kind: 'fill', required: true, label: 'Client signatory name', help: 'Who signs for the client', max: 120 },
  { key: 'client_signatory_title', kind: 'fill', required: false, label: 'Client signatory title', help: 'Signatory title', max: 120, default: '[Title]' },
  { key: 'effective_date', kind: 'fill', required: false, label: 'Effective date', help: 'Leave default for signature-dated', max: 60, default: '[Date of last signature]' },
  { key: 'engagement_ref', kind: 'fill', required: true, label: 'Engagement reference', help: 'e.g. "ACM-2026-001"', max: 60 },
  { key: 'sow_ref', kind: 'fill', required: true, label: 'SOW reference', help: 'e.g. "ACM-SOW-001 — Acme Portal"', max: 120 },
  { key: 'hourly_rate', kind: 'fill', required: false, label: 'Hourly rate (out-of-scope)', help: 'Default $195/hour', max: 30, default: '$195' },
]

export const SLOTS: Record<DocType, SlotSpec[]> = {
  mou: [
    ...SHARED_FILL,
    { key: 'markup_pct', kind: 'fill', required: false, label: 'Third-party markup %', help: 'Default fifteen percent (15%)', max: 40, default: 'fifteen percent (15%)' },
    { key: 'usage_notice_threshold', kind: 'fill', required: false, label: 'Usage-notice threshold', help: 'Default US $500', max: 30, default: 'US $500' },
    { key: 'support_period', kind: 'fill', required: false, label: 'Support period', help: 'Default thirty (30) calendar days', max: 60, default: 'thirty (30) calendar days following the Acceptance Date' },
    { key: 'timeline', kind: 'fill', required: true, label: 'Delivery timeline', help: 'e.g. "eight (8) weeks"', max: 80 },
    { key: 'milestones_table', kind: 'fill', required: true, label: 'Milestone schedule (markdown table)', help: 'A markdown table with #, Milestone, Trigger, Amount rows and a Total', max: 1500, multiline: true },
    { key: 'fee_summary', kind: 'draft', required: true, label: 'Fee summary (§3.1 prose)', help: 'Brief: total fee, any discount, what the Project Fee includes', max: 1800 },
    { key: 'purpose', kind: 'draft', required: true, label: 'Purpose (§1)', help: 'Brief: what is being built and for whom', max: 1500 },
    { key: 'scope_summary', kind: 'draft', required: true, label: 'Scope summary (§2 bullets)', help: 'Brief: the headline capabilities (becomes a bulleted list)', max: 2500 },
    { key: 'managed_service', kind: 'draft', required: false, label: 'Managed-service tiers (§6)', help: 'Brief: tier names, monthly fees, what each includes (becomes a table)', max: 1800, default: 'Following the Acceptance Date, ongoing managed service (hosting operations, monitoring, updates, and optional content operations) is available under a separately quoted monthly tier. Specific tiers and fees will be provided on request.' },
    { key: 'client_responsibilities', kind: 'draft', required: true, label: 'Client responsibilities (§9)', help: 'Brief: what the client must provide (becomes a lettered list)', max: 2000 },
    { key: 'future_phases', kind: 'draft', required: false, label: 'Future phases (§12.2)', help: 'Brief: representative out-of-scope future capabilities (becomes a bulleted list)', max: 1800, default: '- additional modules, integrations, or capabilities not described in the SOW;\n- native or cross-platform mobile applications;\n- third-party system integrations not listed in the SOW.' },
  ],
  sow: [
    ...SHARED_FILL,
    { key: 'overview', kind: 'draft', required: true, label: 'Project overview (§2)', help: 'Brief: what 4ward will build and deliver, and for whom', max: 2500 },
    { key: 'deliverables', kind: 'draft', required: true, label: 'Deliverables (§3)', help: 'Brief: the feature areas to deliver (becomes grouped sub-sections with bullets)', max: 5000 },
    { key: 'acceptance', kind: 'draft', required: true, label: 'Acceptance criteria (§4)', help: 'Brief: the testable conditions for acceptance (becomes a numbered list)', max: 4000 },
    { key: 'out_of_scope', kind: 'draft', required: true, label: 'Out of scope (§5)', help: 'Brief: what is explicitly excluded (becomes a bulleted list)', max: 2500 },
    { key: 'client_responsibilities', kind: 'draft', required: true, label: 'Client responsibilities (§6.2)', help: 'Brief: what the client must provide/do (becomes a bulleted list)', max: 2000 },
    { key: 'assumptions', kind: 'draft', required: false, label: 'Assumptions & dependencies (§7)', help: 'Brief: the scoping assumptions (becomes a numbered list)', max: 2500, default: '1. Client inputs are provided within the windows stated in §6.2; the timeline in MOU §8 runs from timely receipt.\n2. The deliverables are hosted on 4ward’s managed-services stack.\n3. One production environment and one preview environment are delivered; additional environments are available via Change Order.\n4. English-language content and a United States user base are assumed; localization and international regulatory regimes are out of scope.' },
  ],
}

export const TITLES: Record<DocType, string> = {
  mou: 'Memorandum of Understanding — 4ward Motion Solutions, Inc.',
  sow: 'Statement of Work — 4ward Motion Solutions, Inc.',
}

export function skeletonFor(docType: DocType): string {
  return docType === 'mou' ? MOU_SKELETON : SOW_SKELETON
}
