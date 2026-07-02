// Mnemosyne — `brief` tool core (thread 0027 P1-BRIEF + P5-PACK). One capped call replaces the
// recall→fetch→activity orientation fan-out. Assembled in-function from existing reads (no new RPC) —
// resolution spec verified against the live schema 2026-07-02 (see thread 0027 body + KNOWN GAP below).
//
// ⚠️ RESOLUTION HAS TWO PATHS (thread 0028 §1, decided by Fable 2026-07-02: option (b) now, (d) —
// populating `projects` for real — queued as a separate follow-up unit):
//   1. FK path (as originally approved): projects.name -> id, then filter memory_entries/documents by
//      project_id. This is the long-term path and takes priority whenever it resolves.
//   2. memory_slug_fallback: verified against prod 2026-07-02, `projects` has ZERO rows and
//      memory_entries.project_id / documents.project_id are 100% null, so path 1 alone would return
//      "no match" for every real call today. When path 1 finds nothing, fall back to slug-matching
//      `memory_entries` directly (kind='project') — same "fallback, not backfill" pattern as thread
//      0024's `dealOf()` fix, same no-guess discipline (ambiguous/zero matches -> the same structured
//      error, never a guess). `docs` is honestly `[]` under fallback (no project_id to link through —
//      no title-heuristic substitute). The response carries `resolved_via` so callers (and the future
//      (d) backfill unit) can see which path served them, and the fallback becomes unreachable on its
//      own the moment (d) populates `projects` for a given name.
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

type MemEntry = { name: string; title: string; body: string; updated_at: string }

type ResolveResult =
  | { ok: true; via: 'projects_fk'; id: string; name: string }
  | { ok: true; via: 'memory_slug_fallback'; name: string; entry: MemEntry }
  | { ok: false; reason: 'no_match' | 'ambiguous'; candidates: string[] }

// lower, spaces/underscores -> '-', strip anything else non-alnum/hyphen, collapse/trim hyphens.
function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
}

// Resolve a project name. Path 1 (FK, unchanged from the original approved design): case-insensitive
// exact match against projects.name first, else a unique case-insensitive substring match — both are
// inherently 0-or-1 given projects.name is UNIQUE, so ambiguity there can only come from the substring
// arm matching multiple distinct rows. An ambiguous FK result is returned immediately (never falls
// through to path 2 — "no match" specifically triggers the fallback, not "ambiguous match").
//
// Path 2 (memory_slug_fallback, thread 0028 §1(b)): only tried when path 1 found NOTHING. Normalizes
// the input to a slug and matches memory_entries (kind='project'): exact `project-<slug>` first, then
// exact `<slug>` (both 0-or-1 given memory_entries.name is UNIQUE), else a substring candidate set —
// exactly one -> use it; zero or multiple -> the same structured no-guess error as path 1.
//
// Every branch returns a structured result — 0/>1 candidates is an EXPECTED outcome (like
// resume:null), not a system failure, so it's returned, not thrown. Only a genuine DB error throws.
async function resolveProject(admin: any, projectName: string): Promise<ResolveResult> {
  const { data: projects, error: projErr } = await admin.from('projects').select('id, name')
  if (projErr) throw new Error(`brief: project lookup failed: ${projErr.message}`)
  const projectRows: { id: string; name: string }[] = projects ?? []
  const needle = projectName.toLowerCase()

  const exactProject = projectRows.find((p) => p.name.toLowerCase() === needle)
  if (exactProject) return { ok: true, via: 'projects_fk', id: exactProject.id, name: exactProject.name }

  const substrProjects = projectRows.filter((p) => p.name.toLowerCase().includes(needle))
  if (substrProjects.length === 1) return { ok: true, via: 'projects_fk', id: substrProjects[0].id, name: substrProjects[0].name }
  if (substrProjects.length > 1) return { ok: false, reason: 'ambiguous', candidates: substrProjects.map((p) => p.name) }

  // ---- path 1 found nothing at all -> try the memory slug fallback ----
  const slug = slugify(projectName)
  if (!slug) return { ok: false, reason: 'no_match', candidates: [] } // an empty slug would `.includes('')`-match everything

  const { data: memAll, error: memErr } = await admin.from('memory_entries').select('name, title, body, updated_at').eq('kind', 'project')
  if (memErr) throw new Error(`brief: memory slug fallback lookup failed: ${memErr.message}`)
  const memRows: MemEntry[] = memAll ?? []

  const prefixed = memRows.find((m) => m.name === `project-${slug}`)
  if (prefixed) return { ok: true, via: 'memory_slug_fallback', name: projectName, entry: prefixed }

  const exactSlug = memRows.find((m) => m.name === slug)
  if (exactSlug) return { ok: true, via: 'memory_slug_fallback', name: projectName, entry: exactSlug }

  const containsSlug = memRows.filter((m) => m.name.includes(slug))
  if (containsSlug.length === 1) return { ok: true, via: 'memory_slug_fallback', name: projectName, entry: containsSlug[0] }

  return { ok: false, reason: containsSlug.length ? 'ambiguous' : 'no_match', candidates: containsSlug.map((m) => m.name) }
}

export async function runBrief(args: any, { admin }: { admin: any }): Promise<any> {
  const { project: projectName } = validateBriefArgs(args)
  const resolved = await resolveProject(admin, projectName)
  if (!resolved.ok) {
    return { project: projectName, error: resolved.reason, candidates: resolved.candidates }
  }

  // ---- resume + docs + activity-match-key differ per resolution path ----
  let resumeRow: MemEntry | null
  let docRows: any[]
  let activityPid: string | null
  let activityNameKey: string

  if (resolved.via === 'projects_fk') {
    // unchanged from the original approved design: newest kind='project' memory linked by project_id
    const { data: memRows } = await admin
      .from('memory_entries')
      .select('name, title, body, updated_at')
      .eq('project_id', resolved.id)
      .eq('kind', 'project')
      .order('updated_at', { ascending: false })
      .limit(1)
    resumeRow = (memRows ?? [])[0] ?? null
    // docs: metadata only (title, not extracted_text/body — no free-form content surface here).
    // NOTE: documents has no updated_at column (schema-verified 2026-07-02; the design doc assumed
    // one) — created_at is used instead.
    const { data: docs } = await admin.from('documents').select('id, title, doc_type, created_at').eq('project_id', resolved.id)
    docRows = docs ?? []
    activityPid = resolved.id
    activityNameKey = resolved.name
  } else {
    // memory_slug_fallback (thread 0028 §1(b)): the matched entry itself IS the resume — there's no
    // separate project_id to look one up by. docs is honestly [] — project_id linkage doesn't exist
    // for this path, and a title-match heuristic was explicitly rejected (never guess).
    resumeRow = resolved.entry
    docRows = []
    activityPid = null
    activityNameKey = resolved.name
  }

  // ---- resume: egress redaction FIRST (same function fetch() uses), truncation SECOND — same
  //      ordering rationale as thread 0027 build instruction #1: truncating before redaction could
  //      split a secret span across the cut and defeat pattern matching. open_items is extracted from
  //      the REDACTED text too, so a secret sitting on an "OPEN:"-style line can't leak through
  //      either. Unchanged across both resolution paths. ----
  const redactedResumeBody = resumeRow ? redactSecrets(resumeRow.body).text : null
  const resumeCapped = redactedResumeBody !== null ? capText(redactedResumeBody, RESUME_BUDGET) : null
  const openItemsRaw = redactedResumeBody !== null ? extractOpenItems(redactedResumeBody) : []
  const openItemsCapped = capText(openItemsRaw.join('\n'), OPEN_ITEMS_BUDGET)

  // docs is not egress-redacted: unlike memory_entries (which has a known contamination history —
  // incident 0006 — motivating fetch's defense-in-depth redaction), documents titles aren't free-form
  // bodies and activity's own log_activity RPC already secret-scans at ingress.
  const docsCapped = capArray(docRows, DOCS_BUDGET)

  // ---- activity: entity_id match (FK path only — the forward-fix path; fallback has no pid to match)
  //      OR detail->>'project' free-text match (the path that actually carries data today, works for
  //      BOTH resolution paths) — newest 15. Filtered/sorted in TS rather than via a raw PostgREST
  //      jsonb-path filter string: there's no existing precedent for that syntax in this codebase, and
  //      interpolating a free-text project name into a raw filter string is an unnecessary injection
  //      surface. entity_type='project' is a bounded set (low hundreds of rows total), so fetching and
  //      filtering client-side is cheap and easy to verify correct. Unchanged from the original design
  //      other than the pid now being nullable under fallback. ----
  const needleLower = activityNameKey.toLowerCase()
  const { data: projectActRows } = await admin
    .from('activity_log')
    .select('id, action, entity_type, entity_id, detail, created_at')
    .eq('entity_type', 'project')
    .order('created_at', { ascending: false })
    .limit(500) // generous bound on the source set before in-memory filtering; not the final cap
  const matchedActRows = (projectActRows ?? [])
    .filter((r: any) => (activityPid !== null && r.entity_id === activityPid) || (typeof r.detail?.project === 'string' && r.detail.project.toLowerCase() === needleLower))
    .slice(0, ACTIVITY_LIMIT)
  const activityCapped = capArray(matchedActRows, ACTIVITY_BUDGET)

  return {
    project: resolved.via === 'projects_fk' ? resolved.name : projectName,
    resolved_via: resolved.via,
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
