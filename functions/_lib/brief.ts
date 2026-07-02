// Mnemosyne — `brief` tool core (thread 0027 P1-BRIEF + P5-PACK). One capped call replaces the
// recall→fetch→activity orientation fan-out. Assembled in-function from existing reads (no new RPC) —
// resolution spec verified against the live schema 2026-07-02 (see thread 0027 body + KNOWN GAP below).
//
// ⚠️ KNOWN GAP (flagged, not silently papered over): resolution below is FK-based exactly as designed
// (projects.name -> id, then filter memory_entries/documents by project_id). Verified against prod
// 2026-07-02: the `projects` table has ZERO rows, and `memory_entries.project_id` /
// `documents.project_id` are 100% null — the FK linkage this function depends on has never been
// populated. Until `projects` is populated and memory/documents get relinked, step 1 (project
// resolution) will return the "no candidates" error path for every input; activity resolution (which
// matches on the free-text `detail->>'project'` field, not the FK) is NOT affected and works today.
//
// SECURITY: the design doc raised an unresolved question — "brief's resume section returns a memory
// BODY remotely — it must run through the same egress secret-redaction as fetch" — recommending BOTH
// (redact + restrict to kind='project'). Aegis's re-review never explicitly closed this out. Resolved
// here in favor of Atlas's own recommendation: resume is restricted to kind='project' (already true by
// construction, the `.eq('kind','project')` filter below) AND now redacted via the same fetch-core
// redactSecrets — the identical function fetch() uses, not a reimplementation, so both remote surfaces
// give identical guarantees against a memory entry contaminated via the incident-0006-class path.

import { redactSecrets } from '../../mcp/lib/fetch-core.mjs'

const RESUME_BUDGET = 8000
const ACTIVITY_BUDGET = 4000
const OPEN_ITEMS_BUDGET = 2000
const DOCS_BUDGET = 1500
const ACTIVITY_LIMIT = 15

// For prose sections (resume, open_items): character-truncate with an honest marker.
function capText(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false }
  const marker = `\n…[truncated at ${budget} chars]`
  if (marker.length >= budget) return { text: marker.slice(0, budget), truncated: true }
  return { text: text.slice(0, budget - marker.length) + marker, truncated: true }
}

// For structured sections (activity, docs): char-truncating a serialized JSON array breaks it (an
// arbitrary cut point is rarely valid JSON). Drop trailing elements instead until it fits — keeps the
// output honestly parseable and still flags truncation when anything was dropped.
function capArray<T>(rows: T[], budget: number): { rows: T[]; truncated: boolean } {
  if (JSON.stringify(rows).length <= budget) return { rows, truncated: false }
  let kept = rows.slice()
  while (kept.length > 0 && JSON.stringify(kept).length > budget) kept = kept.slice(0, -1)
  return { rows: kept, truncated: true }
}

// Pull lines that look like an open-items/next-steps marker out of a resume body — cheap heuristic,
// not a parser. Matches a leading bullet/emoji + one of OPEN/NEXT/TODO (case-insensitive).
const OPEN_ITEM_RE = /^\s*(?:[-*•]|\d+[.)])?\s*(?:🔴|📋|⚠️)?\s*(open|next|todo)\b/i
function extractOpenItems(resumeBody: string): string[] {
  return resumeBody.split('\n').filter((line) => OPEN_ITEM_RE.test(line)).map((l) => l.trim())
}

export function validateBriefArgs(args: any): { project: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('brief: arguments must be an object')
  for (const k of Object.keys(args)) if (k !== 'project') throw new Error(`brief: unexpected argument "${k}"`)
  if (typeof args.project !== 'string' || !args.project.trim()) throw new Error('brief: "project" must be a non-empty string')
  if (args.project.length > 200) throw new Error('brief: "project" exceeds 200 chars')
  return { project: args.project.trim() }
}

type ResolveResult =
  | { ok: true; project: { id: string; name: string } }
  | { ok: false; reason: 'no_match' | 'ambiguous'; candidates: string[] }

// Resolve a project name against projects.name: case-insensitive exact match first, else a unique
// case-insensitive substring match. 0 or >1 candidates -> a structured non-throwing result (never
// guess) — this is an EXPECTED outcome (like resume:null), not a system failure, so it's returned,
// not thrown. Only a genuine DB error throws.
async function resolveProject(admin: any, projectName: string): Promise<ResolveResult> {
  const { data: projects, error } = await admin.from('projects').select('id, name')
  if (error) throw new Error(`brief: project lookup failed: ${error.message}`)
  const rows: { id: string; name: string }[] = projects ?? []
  const needle = projectName.toLowerCase()

  const exact = rows.filter((p) => p.name.toLowerCase() === needle)
  if (exact.length === 1) return { ok: true, project: exact[0] }

  const substr = rows.filter((p) => p.name.toLowerCase().includes(needle))
  if (substr.length === 1) return { ok: true, project: substr[0] }

  const ambiguous = exact.length > 1 ? exact : substr
  return { ok: false, reason: ambiguous.length ? 'ambiguous' : 'no_match', candidates: ambiguous.map((p) => p.name) }
}

export async function runBrief(args: any, { admin }: { admin: any }): Promise<any> {
  const { project: projectName } = validateBriefArgs(args)
  const resolved = await resolveProject(admin, projectName)
  if (!resolved.ok) {
    return { project: projectName, error: resolved.reason, candidates: resolved.candidates }
  }
  const project = resolved.project

  // ---- resume: newest kind='project' memory for this project; none -> null, not an error ----
  const { data: memRows } = await admin
    .from('memory_entries')
    .select('name, title, body, updated_at')
    .eq('project_id', project.id)
    .eq('kind', 'project')
    .order('updated_at', { ascending: false })
    .limit(1)
  const resumeRow = (memRows ?? [])[0] ?? null
  // egress redaction FIRST (same function fetch() uses), truncation SECOND — same ordering rationale
  // as thread 0027 build instruction #1: truncating before redaction could split a secret span across
  // the cut and defeat pattern matching. open_items is extracted from the REDACTED text too, so a
  // secret sitting on an "OPEN:"-style line can't leak through that section either.
  const redactedResumeBody = resumeRow ? redactSecrets(resumeRow.body).text : null
  const resumeCapped = redactedResumeBody !== null ? capText(redactedResumeBody, RESUME_BUDGET) : null
  const openItemsRaw = redactedResumeBody !== null ? extractOpenItems(redactedResumeBody) : []
  const openItemsCapped = capText(openItemsRaw.join('\n'), OPEN_ITEMS_BUDGET)

  // ---- docs: metadata only (title, not extracted_text/body — no free-form content surface here).
  //      NOTE: documents has no updated_at column (schema-verified 2026-07-02; the design doc assumed
  //      one) — created_at is used instead. Not egress-redacted: unlike memory_entries (which has a
  //      known contamination history — incident 0006 — motivating fetch's defense-in-depth redaction),
  //      activity_log/documents titles aren't free-form bodies and activity's own log_activity RPC
  //      already secret-scans at ingress. ----
  const { data: docRows } = await admin
    .from('documents')
    .select('id, title, doc_type, created_at')
    .eq('project_id', project.id)
  const docsCapped = capArray(docRows ?? [], DOCS_BUDGET)

  // ---- activity: entity_id match (the FK forward path) OR detail->>'project' free-text match (the
  //      path that actually carries data today) — newest 15. Filtered/sorted in TS rather than via a
  //      raw PostgREST jsonb-path filter string: there's no existing precedent for that syntax in this
  //      codebase, and interpolating a free-text project name into a raw filter string is an
  //      unnecessary injection surface. entity_type='project' is a bounded set (low hundreds of rows
  //      total), so fetching and filtering client-side is cheap and easy to verify correct. ----
  const needleLower = project.name.toLowerCase()
  const { data: projectActRows } = await admin
    .from('activity_log')
    .select('id, action, entity_type, entity_id, detail, created_at')
    .eq('entity_type', 'project')
    .order('created_at', { ascending: false })
    .limit(500) // generous bound on the source set before in-memory filtering; not the final cap
  const matchedActRows = (projectActRows ?? [])
    .filter((r: any) => r.entity_id === project.id || (typeof r.detail?.project === 'string' && r.detail.project.toLowerCase() === needleLower))
    .slice(0, ACTIVITY_LIMIT)
  const activityCapped = capArray(matchedActRows, ACTIVITY_BUDGET)

  return {
    project: project.name,
    resume: resumeCapped ? resumeCapped.text : null,
    resume_note: resumeRow ? undefined : 'no kind="project" memory entry linked to this project',
    activity: activityCapped.rows,
    open_items: openItemsRaw.length ? openItemsCapped.text.split('\n') : [],
    docs: docsCapped.rows,
    truncated: {
      resume: resumeCapped?.truncated ?? false,
      activity: activityCapped.truncated,
      open_items: openItemsCapped.truncated,
      docs: docsCapped.truncated,
    },
  }
}
