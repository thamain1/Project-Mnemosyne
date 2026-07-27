// Unit L live smoke. Run only after migrations 0034 + 0036 are applied:
// node --env-file=.env.local scripts/smoke-librarian.mjs
//
// Method: the librarian is run TWICE -- once before fixtures to capture a baseline of all four
// counts using its own predicates, then again with fixtures in place -- and every section is
// asserted on an exact count DELTA. Sample arrays are checked only for shape and cap honesty.
// Searching a sample for a fixture is not a valid assertion: each *_json is a capped excerpt
// (0034 L3 trim loop, tightened in 0036), so on a real database the fixture is usually trimmed out.
import { createClient } from '@supabase/supabase-js'

const URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !SERVICE) {
  console.error('missing VITE_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const db = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const prefix = `smoke-0034-${stamp}`
const names = {
  stale: `${prefix}-stale`, dupA: `${prefix}-dup-a`, dupB: `${prefix}-dup-b`,
  dead: `${prefix}-dead-link`, agentA: `${prefix}-agent-a`, agentB: `${prefix}-agent-b`, agentC: `${prefix}-agent-c`,
}

// Distinct one-hot vectors per fixture. Previously every fixture shared ONE vector, so all seven were
// mutual near-duplicates (C(7,2)=21 pairs) and no exact near-dup delta was assertable. dupA/dupB
// deliberately share a vector so they are the ONLY new pair. A one-hot is ~1.0 cosine distance from
// any real Gemini embedding, far outside the 0.10 near-dup threshold, so it cannot pair with live data.
const oneHot = (i) => `[${Array.from({ length: 768 }, (_, j) => (j === i ? '1' : '0')).join(',')}]`

// digest_date is Postgres current_date, i.e. the server's UTC date -- match on UTC components, not
// local ones. A local-date build would target the wrong digest_date whenever the two disagree.
const now = new Date()
const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`

let pass = 0, fail = 0
function check(label, ok, detail = '') { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`) }

// The digest always stamps source='cron' (0034 L3), so the original `.like('detail->>source','smoke')`
// predicate matched nothing and the smoke left its digest row behind. Because run_memory_librarian is
// same-day idempotent, that made a second same-day run silently assert against the PREVIOUS run's
// digest. Delete by digest_date instead.
// NOTE: this consumes today's digest slot; the daily cron will not re-emit until tomorrow. The digest
// is report-only and fully regenerable, so that is a deliberate, stated trade for a repeatable smoke.
async function deleteDigest() {
  const { error } = await db.from('activity_log').delete().eq('action', 'librarian.digest').eq('detail->>digest_date', today)
  if (error) throw new Error(`deleteDigest: ${error.message}`)
}
async function removeFixtures() {
  await deleteDigest()
  await db.from('memory_entries').delete().in('name', Object.values(names))
}
async function insert(name, extra = {}) {
  const { error } = await db.from('memory_entries').insert({ name, kind: 'reference', title: name, body: `Smoke fixture ${name}`, links: extra.links ?? [], source_path: extra.source_path ?? `mcp/${name}`, embedding_model: 'gemini-embedding-001', embedding: extra.embedding, tags: extra.tags ?? [], verified_at: extra.verified_at ?? new Date().toISOString(), archived: extra.archived ?? false })
  if (error) throw new Error(`fixture insert ${name}: ${error.message}`)
}
async function runDigest(label) {
  const { error } = await db.rpc('run_memory_librarian')
  if (error) throw new Error(`${label}: ${error.message}`)
  const { data, error: readError } = await db.from('activity_log').select('detail').eq('action', 'librarian.digest').eq('detail->>digest_date', today).limit(1)
  if (readError) throw new Error(`${label} read: ${readError.message}`)
  if (!data?.length) throw new Error(`${label}: no digest row for ${today}`)
  return data[0].detail ?? {}
}
const SECTIONS = ['stale', 'near_dups', 'dead_links', 'consolidation']

try {
  await removeFixtures()

  // --- baseline: the librarian's own counts with no fixtures present ---
  const base = await runDigest('baseline digest')
  check('baseline digest produced', typeof base.digest_date === 'string', `digest_date=${base.digest_date}`)
  await deleteDigest()

  // --- fixtures ---
  await insert(names.stale, { embedding: oneHot(0), verified_at: new Date(Date.now() - 7 * 30 * 24 * 60 * 60 * 1000).toISOString() })
  await insert(names.dupA, { embedding: oneHot(1) })
  await insert(names.dupB, { embedding: oneHot(1) })
  await insert(names.dead, { embedding: oneHot(2), links: [`${prefix}-missing`] })
  await insert(names.agentA, { embedding: oneHot(3), source_path: `agent/smoke-client/${names.agentA}`, tags: ['client:smoke-client'] })
  await insert(names.agentB, { embedding: oneHot(4), source_path: `agent/smoke-client/${names.agentB}`, tags: ['client:smoke-client'] })
  await insert(names.agentC, { embedding: oneHot(5), source_path: `agent/smoke-client/${names.agentC}`, tags: ['client:smoke-client'] })

  const d = await runDigest('fixture digest')

  for (const key of SECTIONS) {
    check(`digest has ${key}_json section`, typeof d[`${key}_json`] === 'string')
    check(`digest has ${key}_truncated flag`, typeof d[`${key}_truncated`] === 'boolean', `got ${typeof d[`${key}_truncated`]}`)
  }

  // --- exact count deltas (0036 QC fix: every section, not just dead links) ---
  const delta = (k) => Number(d[`${k}_count`]) - Number(base[`${k}_count`])
  check('stale delta = 1 (the 7-month-old fixture)', delta('stale') === 1, `${base.stale_count} -> ${d.stale_count}`)
  check('near_dups delta = 1 (dupA/dupB only)', delta('near_dups') === 1, `${base.near_dups_count} -> ${d.near_dups_count}`)
  check('dead_links delta = 1', delta('dead_links') === 1, `${base.dead_links_count} -> ${d.dead_links_count}`)
  check('consolidation delta = 1 (client:smoke-client group)', delta('consolidation') === 1, `${base.consolidation_count} -> ${d.consolidation_count}`)

  // --- 0036: NULL verified_at means "never verified" and must be QUEUED, not skipped ---
  const { count: nullRows } = await db.from('memory_entries').select('name', { count: 'exact', head: true }).is('verified_at', null).eq('archived', false)
  check('never_verified_count matches live NULL rows', Number(d.never_verified_count) === nullRows, `digest=${d.never_verified_count} live=${nullRows}`)
  check('never-verified rows are inside the stale queue', Number(d.stale_count) >= nullRows, `stale=${d.stale_count} never_verified=${nullRows}`)
  // Fixtures all set verified_at, so they must not inflate the never-verified figure.
  check('fixtures did not change never_verified_count', Number(d.never_verified_count) === Number(base.never_verified_count),
    `${base.never_verified_count} -> ${d.never_verified_count}`)

  // --- truncation honesty: the flag must agree with count vs sample length, in both directions ---
  for (const key of SECTIONS) {
    const sample = JSON.parse(d[`${key}_json`] ?? '[]')
    const count = Number(d[`${key}_count`])
    check(`${key} sample never exceeds its count`, Array.isArray(sample) && sample.length <= count, `sample=${sample.length} count=${count}`)
    check(`${key}_truncated agrees with count vs sample`, d[`${key}_truncated`] === (count > sample.length),
      `flag=${d[`${key}_truncated`]} count=${count} sample=${sample.length}`)
  }

  // --- detail must stay inside log_activity's 4096-byte cap (0036 lowered the per-section cap) ---
  const detailBytes = Buffer.byteLength(JSON.stringify(d), 'utf8')
  check('digest detail within the 4096-byte cap', detailBytes <= 4096, `${detailBytes} bytes`)

  // --- same-day idempotency ---
  const second = await db.rpc('run_memory_librarian')
  check('same-day run is idempotent', !second.error, second.error?.message)
  const { count } = await db.from('activity_log').select('id', { count: 'exact', head: true }).eq('action', 'librarian.digest').eq('detail->>digest_date', today)
  check('same-day run leaves one digest row', count === 1, `count=${count}`)
} catch (error) { console.error(error.message); fail++ }
finally { try { await removeFixtures() } catch (error) { console.error(`cleanup failed: ${error.message}`); fail++ } }

console.log(`[smoke-librarian] pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
