#!/usr/bin/env node
// Mnemosyne — projects backfill (thread 0030, the 0028 §1 decision (d) follow-up unit).
//
// NO new migration — the projects/memory_entries.project_id/documents.project_id schema has existed
// since 0001_init.sql; the columns have simply never been populated. This is a data unit, ONE
// idempotent script covering all four steps:
//   A. seed `projects` — one row per active build (case-insensitive match-then-create, never a
//      duplicate).
//   B. backfill `memory_entries.project_id` for existing kind='project' entries via explicit
//      prefix/exact rules — only rows where project_id IS NULL, so a re-run never clobbers a manual
//      correction. Ambiguous or unmappable entries are left NULL and listed — never guessed.
//   C. backfill `documents.project_id` for the (small, fixed) set of existing documents, via a
//      title-prefix rule. Same NULL-and-report discipline.
//   D. create/refresh the Mnemosyne resume entry itself, which has never existed as a kind='project'
//      memory (see the header comment on extractCurrentResumeBullet for why). Needs GEMINI_API_KEY —
//      skipped with a clear message if it's not in the environment, so A-C still run standalone.
//
// Run (steps A-C only):      node --env-file=.env.local scripts/backfill-projects.mjs [--dry-run]
// Run (all steps incl. D):   node --env-file=.env.local --env-file=mcp/.env.local scripts/backfill-projects.mjs [--dry-run]

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const URL = process.env.VITE_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const GEMINI = process.env.GEMINI_API_KEY
if (!URL || !SERVICE) { console.error('missing env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)'); process.exit(1) }
const DRY = process.argv.includes('--dry-run')
const OWNER_EMAIL = 'jmorgan@4wardmotions.com'
const MEMORY_FILE = process.env.MIRROR_MEMORY_DIR
  ? `${process.env.MIRROR_MEMORY_DIR}/project_mnemosyne.md`
  : 'C:/Users/ThaMain1/.claude/projects/C--dev/memory/project_mnemosyne.md'

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

// ── canonical active-builds roster (thread 0030 §1) — names are the `brief` lookup keys, so they MUST
//    match what a teammate would actually type. ──────────────────────────────────────────────────────
const PROJECTS = [
  { name: 'Mnemosyne', status: 'active', summary: 'This repo; 4ward Motion Solutions\' shared second brain (continuity core + hosted MCP).' },
  { name: 'GIAV', status: 'active', summary: 'Beth Underhill; women\'s financial-literacy platform. giav.pages.dev.' },
  { name: 'GIAV Academy', status: 'done', summary: 'Done unit, kept for history linkage.' },
  { name: 'OnTheHash', status: 'active', summary: 'World Cup 2026 watch-party discovery + venue campaign listings. onthehash.com.' },
  { name: 'Perks & Plays', status: 'active', summary: 'Loyalty/rewards platform, alias "The Playbook". perksandplays.com.' },
  { name: 'IntelliTax', status: 'active', summary: 'Tax return prep + document extraction platform.' },
  { name: 'ImpactTracker', status: 'active', summary: 'Impact reporting platform.' },
  { name: 'MentorApp / P2PNow', status: 'active', summary: 'Standalone mentorship app, split from Just-As-I-Am 2026-05-19. p2pnow.org.' },
  { name: 'SpencerLeadGen', status: 'active', summary: 'Spencer\'s Consulting speaker-opportunity platform (docs-only pilot).' },
  { name: 'Pallets', status: 'active', summary: 'Pallet-Lead-Agents single-tenant platform pilot.' },
  { name: 'Pallets-Site', status: 'active', summary: 'Marketing-site sibling to the Pallets pilot.' },
  { name: 'IntelliService', status: 'active', summary: 'Master/ISB/SB/MES family — one row; per-build rows only if entries force it.' },
  { name: 'IntelliOptics 2.5', status: 'active', summary: 'AI inspection platform, current version.' },
  { name: '4wardmotion-site', status: 'active', summary: '4ward\'s own B2B landing page. 4wardmotions.com.' },
]

async function stepA() {
  console.log('\n=== Step A: seed projects ===')
  const { data: owner, error: ownerErr } = await admin.from('team_members').select('id').eq('email', OWNER_EMAIL).maybeSingle()
  if (ownerErr || !owner) throw new Error(`could not resolve owner (${OWNER_EMAIL}): ${ownerErr?.message ?? 'not found'}`)

  const { data: existing, error: exErr } = await admin.from('projects').select('id, name')
  if (exErr) throw new Error(`projects lookup failed: ${exErr.message}`)
  const byLowerName = new Map(existing.map((p) => [p.name.toLowerCase(), p]))

  const idByName = new Map()
  let created = 0, skipped = 0
  for (const p of PROJECTS) {
    const found = byLowerName.get(p.name.toLowerCase())
    if (found) { idByName.set(p.name, found.id); skipped++; console.log(`  exists       ${p.name} (${found.id})`); continue }
    if (DRY) { idByName.set(p.name, 'DRY-RUN-ID'); console.log(`  would-create ${p.name}`); created++; continue }
    const { data: ins, error: insErr } = await admin.from('projects').insert({ name: p.name, status: p.status, summary: p.summary, owner_id: owner.id }).select('id').single()
    if (insErr) throw new Error(`insert project "${p.name}" failed: ${insErr.message}`)
    idByName.set(p.name, ins.id)
    created++
    console.log(`  created      ${p.name} (${ins.id})`)
  }
  console.log(`Step A: ${created} ${DRY ? 'would-be-created' : 'created'}, ${skipped} already existed`)
  return { idByName, created, skipped }
}

// ── Step B mapping rules. Order: exclusions (known-ambiguous or genuinely out-of-scope names that
//    would otherwise false-positive-match a prefix) → exact overrides → prefixes (first match wins).
//    NEVER GUESS: anything not matched here stays NULL and is listed in the report. ──────────────────
const EXCLUDED_AMBIGUOUS = new Map([
  ['crossover-bridge-oth-perks-live', 'dual-project (OnTheHash + Perks) — ambiguous, left NULL'],
  ['project-onthehash-commercial', 'dual-project (OnTheHash + Perks combined engagement) — ambiguous, left NULL'],
  ['project-oth-perks-migration-deferred', 'dual-project (OnTheHash + Perks) — ambiguous, left NULL'],
  ['project-4ward-anthropic-access', 'about company AI-tooling/vendor access, not the Mnemosyne product itself'],
  ['mentorapp-multitenant', 'content is about Just-As-I-Am (a split-off product), not P2PNow, despite the name prefix'],
  ['p2p-website', '"P2P Community Development Inc." marketing site — a different entity than P2PNow'],
  ['project-intellisign-commercial', 'IntelliSign\'s placement (IntelliService family vs standalone) is genuinely unclear'],
  ['project-buildregistry-data-gaps', 'cross-project meta note (MEMORY.md table gaps), not about one project'],
  ['project-graphify-pass', 'a tooling adoption decision, not a project'],
  ['project-arsenaliq-partnership', 'ArsenalIQ is not in the canonical active-builds list'],
  ['project-ksos-pitch-deck', 'KSOS is not in the canonical active-builds list'],
])

const EXACT_RULES = new Map([
  ['project-4ward', 'Mnemosyne'],            // historical pre-rename (2026-06-15) entry for what is now Mnemosyne
  ['project-pallets-site', 'Pallets-Site'],  // must win over the generic "project-pallets" prefix below
])

const PREFIX_RULES = [
  ['4wardmotion', '4wardmotion-site'],
  ['giav', 'GIAV'],
  ['impacttracker', 'ImpactTracker'],
  ['intellioptics', 'IntelliOptics 2.5'],
  ['intelliservice', 'IntelliService'],
  ['intellitax', 'IntelliTax'],
  ['mentorapp', 'MentorApp / P2PNow'],
  ['onthehash', 'OnTheHash'],
  ['perks', 'Perks & Plays'],
  ['project-giav', 'GIAV'],
  ['project-io-', 'IntelliOptics 2.5'],       // "IO" = the team's internal IntelliOptics abbreviation
  ['project-isb-', 'IntelliService'],         // ISB = one of the IntelliService family builds
  ['project-mentorapp', 'MentorApp / P2PNow'],
  ['project-onthehash', 'OnTheHash'],
  ['project-p2pnow', 'MentorApp / P2PNow'],
  ['project-pallets', 'Pallets'],
  ['project-perks', 'Perks & Plays'],
  ['project-spencerleadgen', 'SpencerLeadGen'],
  ['session-handoff-oth', 'OnTheHash'],
]

function resolveProjectForEntryName(name) {
  if (EXCLUDED_AMBIGUOUS.has(name)) return { project: null, reason: EXCLUDED_AMBIGUOUS.get(name) }
  if (EXACT_RULES.has(name)) return { project: EXACT_RULES.get(name), reason: 'exact-name rule' }
  for (const [prefix, project] of PREFIX_RULES) {
    if (name.startsWith(prefix)) return { project, reason: `prefix "${prefix}"` }
  }
  return { project: null, reason: 'no rule matched' }
}

async function stepB(idByName) {
  console.log('\n=== Step B: backfill memory_entries.project_id (kind=\'project\', project_id IS NULL only) ===')
  const { data: rows, error } = await admin.from('memory_entries').select('id, name').eq('kind', 'project').is('project_id', null)
  if (error) throw new Error(`memory_entries lookup failed: ${error.message}`)
  let mapped = 0, left = 0
  const unmapped = []
  for (const row of rows) {
    const { project, reason } = resolveProjectForEntryName(row.name)
    const pid = project ? idByName.get(project) : null
    if (!project || !pid) {
      left++
      const why = !project ? reason : `target project "${project}" not found/created`
      unmapped.push(`${row.name} — ${why}`)
      console.log(`  NULL         ${row.name} — ${why}`)
      continue
    }
    if (DRY) { console.log(`  would-map    ${row.name} -> ${project} (${reason})`); mapped++; continue }
    // .is('project_id', null) in the UPDATE itself (0031 Aegis note): the select already filters on
    // NULL, but a manual update racing between select and update must not be clobbered.
    const { error: updErr } = await admin.from('memory_entries').update({ project_id: pid }).eq('id', row.id).is('project_id', null)
    if (updErr) throw new Error(`update memory_entries "${row.name}" failed: ${updErr.message}`)
    console.log(`  mapped       ${row.name} -> ${project} (${reason})`)
    mapped++
  }
  console.log(`Step B: ${mapped} ${DRY ? 'would-be-mapped' : 'mapped'}, ${left} left NULL`)
  return { mapped, left, unmapped }
}

// ── Step C mapping: 12 of the 13 existing documents are client contracts titled
//    "<Client/Project> — <doc type>" (origin='ingested') — title-prefix is a clean, deterministic
//    signal there. The 13th is origin='rendered' — produced by Mnemosyne's OWN Document Factory
//    feature (a self-test/demo artifact, not a client deliverable) — the task's own acceptance text
//    ("this repo's rendered docs should link") points at exactly this: any origin='rendered' document
//    belongs to Mnemosyne itself, regardless of title. ───────────────────────────────────────────────
const DOC_TITLE_PREFIX_RULES = [
  ['OnTheHash', 'OnTheHash'],
  ['Spencer', 'SpencerLeadGen'],
  ['GIAV', 'GIAV'],
]

async function stepC(idByName) {
  console.log('\n=== Step C: backfill documents.project_id (project_id IS NULL only) ===')
  const { data: rows, error } = await admin.from('documents').select('id, title, origin').is('project_id', null)
  if (error) throw new Error(`documents lookup failed: ${error.message}`)
  let mapped = 0, left = 0
  const unmapped = []
  for (const row of rows) {
    const rule = DOC_TITLE_PREFIX_RULES.find(([prefix]) => row.title.startsWith(prefix))
    const project = rule?.[1] ?? (row.origin === 'rendered' ? 'Mnemosyne' : null)
    const pid = project ? idByName.get(project) : null
    if (!project || !pid) {
      left++
      const why = !project ? 'no title-prefix rule matched (likely a company-level doc, not project-specific)' : `target project "${project}" not found/created`
      unmapped.push(`${row.title} — ${why}`)
      console.log(`  NULL         ${row.title} — ${why}`)
      continue
    }
    if (DRY) { console.log(`  would-map    ${row.title} -> ${project}`); mapped++; continue }
    const { error: updErr } = await admin.from('documents').update({ project_id: pid }).eq('id', row.id).is('project_id', null)
    if (updErr) throw new Error(`update documents "${row.title}" failed: ${updErr.message}`)
    console.log(`  mapped       ${row.title} -> ${project}`)
    mapped++
  }
  console.log(`Step C: ${mapped} ${DRY ? 'would-be-mapped' : 'mapped'}, ${left} left NULL`)
  return { mapped, left, unmapped }
}

// ── Step D. INVESTIGATION (recorded here, not just in the thread doc): the bulk ingest that populated
//    the other ~69 kind='project' entries ran ONCE on 2026-06-16 (their updated_at timestamps cluster
//    tightly around 2026-06-16 03:51). A `project-4ward` entry from that exact batch documents the
//    PRE-RENAME codename — meaning the local memory file was still named for the old "Project 4ward"
//    codename at ingest time. The file was renamed to `project_mnemosyne.md` afterward (as part of the
//    ongoing two-tier memory architecture rollout) but scripts/ingest-embed.mjs was never re-run since,
//    so the renamed file was never (re-)ingested as a fresh entry — `project-4ward` is a stale fossil,
//    and no `project-mnemosyne`/`mnemosyne` entry has ever existed.
//    DECISION: do NOT re-run the full bulk ingest-embed.mjs pipeline here — that would sweep in dozens
//    of other possibly-stale-vs-renamed files, which is a much bigger blast radius than this unit's
//    stated scope ("owns nothing else"). Instead, create/refresh ONLY this one entry via the sanctioned
//    ingest_memory_entry RPC (file-backed provenance, matching its 69 siblings) — not a raw insert, and
//    not the full-pipeline re-run. A broader "sweep for other stale/renamed topic files" is a separate,
//    later concern if anyone wants it — out of scope here.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// The RESUME section accumulates one dated bullet per update (894 lines, ~100KB total — far over
// remember/ingest's chunk caps and not what "current state" means anyway). The file's own convention
// is that the FIRST bullet under the heading is current; everything below it is historical/superseded
// ("*(superseded by the entry above)*" markers appear on later bullets). Extract just that one.
function extractCurrentResumeBullet(raw) {
  const lines = raw.split('\n')
  const resumeIdx = lines.findIndex((l) => l.startsWith('## ⭐ RESUME'))
  if (resumeIdx === -1) throw new Error('no "## ⭐ RESUME" heading found in project_mnemosyne.md')
  for (let i = resumeIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line) return line.replace(/^- /, '')
  }
  throw new Error('no bullet content found under the RESUME heading')
}

async function embedDocument(text, apiKey) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ content: { parts: [{ text }] }, taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 }),
  })
  if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`)
  const values = (await res.json())?.embedding?.values
  if (!Array.isArray(values) || values.length !== 768 || !values.every(Number.isFinite)) throw new Error('bad embedding shape')
  const norm = Math.sqrt(values.reduce((s, x) => s + x * x, 0))
  if (!(norm > 0)) throw new Error('zero norm')
  return '[' + values.map((x) => x / norm).join(',') + ']'
}

async function stepD(idByName) {
  console.log('\n=== Step D: create/refresh the Mnemosyne resume entry ===')
  if (!GEMINI) {
    console.log('  SKIPPED — GEMINI_API_KEY not present (run with --env-file=mcp/.env.local too to include this step)')
    return { skipped: true }
  }

  const raw = readFileSync(MEMORY_FILE, 'utf8')
  const bulletText = extractCurrentResumeBullet(raw)
  const dateMatch = bulletText.match(/(\d{4}-\d{2}-\d{2})/)
  const title = `Mnemosyne — current state${dateMatch ? ` (${dateMatch[1]})` : ''}`
  const body = `# Mnemosyne — current state\n\n${bulletText}`

  const { data: existing, error: exErr } = await admin.from('memory_entries').select('id, body').eq('name', 'project-mnemosyne').maybeSingle()
  if (exErr) throw new Error(`lookup failed: ${exErr.message}`)
  if (existing && existing.body === body) {
    console.log(`  up-to-date   project-mnemosyne (${existing.id}) — body unchanged since last run, skipping`)
    return { skipped: false, upToDate: true }
  }

  if (DRY) { console.log(`  would-${existing ? 'refresh' : 'create'}  project-mnemosyne (title="${title}", body ${body.length} chars)`); return { skipped: false, wouldWrite: true } }

  const vec = await embedDocument(body, GEMINI)
  const { error: ingestErr } = await admin.rpc('ingest_memory_entry', {
    payload: { name: 'project-mnemosyne', kind: 'project', title, body, links: [], source_path: 'memory/project-mnemosyne.md', embedding_model: 'gemini-embedding-001', embedding: vec, chunks: [] },
  })
  if (ingestErr) throw new Error(`ingest_memory_entry failed: ${ingestErr.message}`)

  const { data: row, error: findErr } = await admin.from('memory_entries').select('id').eq('name', 'project-mnemosyne').single()
  if (findErr) throw new Error(`could not find entry after ingest: ${findErr.message}`)

  const mnemosynePid = idByName.get('Mnemosyne')
  if (mnemosynePid && mnemosynePid !== 'DRY-RUN-ID') {
    const { error: linkErr } = await admin.from('memory_entries').update({ project_id: mnemosynePid }).eq('id', row.id).is('project_id', null)
    if (linkErr) throw new Error(`linking project_id failed: ${linkErr.message}`)
  }
  console.log(`  ${existing ? 'refreshed' : 'created'}    project-mnemosyne (${row.id})${mnemosynePid ? ` -> linked to Mnemosyne (${mnemosynePid})` : ''}`)
  return { skipped: false, wrote: true, created: !existing }
}

async function main() {
  console.log(`${DRY ? 'DRY RUN (no writes)' : 'APPLY'} — backfill-projects (thread 0030)`)
  const { idByName, created: projectsCreated, skipped: projectsSkipped } = await stepA()
  const b = await stepB(idByName)
  const c = await stepC(idByName)
  const d = await stepD(idByName)

  console.log('\n=== SUMMARY ===')
  console.log(`Step A (projects seeded):        ${projectsCreated} created, ${projectsSkipped} already existed`)
  console.log(`Step B (memory_entries mapped):   ${b.mapped} mapped, ${b.left} left NULL`)
  if (b.unmapped.length) b.unmapped.forEach((u) => console.log(`    - ${u}`))
  console.log(`Step C (documents mapped):        ${c.mapped} mapped, ${c.left} left NULL`)
  if (c.unmapped.length) c.unmapped.forEach((u) => console.log(`    - ${u}`))
  console.log(`Step D (Mnemosyne resume entry):  ${d.skipped ? 'SKIPPED (no GEMINI_API_KEY)' : d.upToDate ? 'up-to-date, no write' : d.created ? 'created' : d.wrote ? 'refreshed' : d.wouldWrite ? 'would-write' : 'no-op'}`)
}

main().catch((e) => { console.error('BACKFILL ERROR:', e.stack || e.message); process.exit(1) })
