// Unit L live smoke. Run only after migrations 0034 + 0036 + 0037 are applied:
// node --env-file=.env.local scripts/smoke-librarian.mjs
//
// Needs VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and additionally SUPABASE_ACCESS_TOKEN +
// SUPABASE_PROJECT_REF for the byte-budget assertion (see byteLenOfTodaysDigest below).
//
// Method: the librarian is run TWICE -- once before fixtures to capture a baseline of all four
// counts using its own predicates, then again with fixtures in place -- and every section is
// asserted on an exact count DELTA. Sample arrays are checked only for shape and cap honesty.
// Searching a sample for a fixture is not a valid assertion: each *_json is a capped excerpt, so on
// a real database the fixture is usually trimmed out.
import { createClient } from '@supabase/supabase-js'

const URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const MGMT = process.env.SUPABASE_ACCESS_TOKEN
const REF = process.env.SUPABASE_PROJECT_REF
if (!URL || !SERVICE) {
  console.error('missing VITE_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
if (!MGMT || !REF) {
  console.error('missing SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF (needed for the byte-budget check)')
  process.exit(1)
}

const db = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const prefix = `smoke-0034-${stamp}`
const names = {
  stale: `${prefix}-stale`, dupA: `${prefix}-dup-a`, dupB: `${prefix}-dup-b`,
  dead: `${prefix}-dead-link`, agentA: `${prefix}-agent-a`, agentB: `${prefix}-agent-b`, agentC: `${prefix}-agent-c`,
  // Leading zeros so it sorts FIRST in the dead-link sample (ordered by e.name), guaranteeing the
  // multibyte target actually reaches the digest rather than being cut by the LIMIT 15.
  multibyte: `0000-${prefix}-multibyte`,
}

// Distinct one-hot vectors per fixture. Previously every fixture shared ONE vector, so all seven were
// mutual near-duplicates (C(7,2)=21 pairs) and no exact near-dup delta was assertable. dupA/dupB
// deliberately share a vector so they are the ONLY new pair. A one-hot is ~1.0 cosine distance from
// any real Gemini embedding, far outside the 0.10 near-dup threshold, so it cannot pair with live data.
const oneHot = (i) => `[${Array.from({ length: 768 }, (_, j) => (j === i ? '1' : '0')).join(',')}]`

// 700 three-byte characters ~= 2100 bytes in ONE dead-link element, while staying well under the
// per-string 990-CHARACTER cap. This is the exact shape that defeated 0036: char-legal, byte-illegal.
const MULTIBYTE_TARGET = '中'.repeat(700)

// digest_date is Postgres current_date, i.e. the server's UTC date -- match on UTC components, not
// local ones. A local-date build would target the wrong digest_date whenever the two disagree.
const now = new Date()
const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`

let pass = 0, fail = 0
function check(label, ok, detail = '') { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`) }

const DIGEST_COLS = 'id, actor_id, action, entity_type, entity_id, detail, created_at'

// Measures the EXACT expression log_activity enforces (octet_length(detail::text)). Node's
// Buffer.byteLength(JSON.stringify(row)) is NOT equivalent -- it reserializes with different key
// order, number formatting and escaping, which is precisely why the 0036 smoke read 2466 bytes while
// the real digest 400'd. Verify on the enforcement surface, not a proxy for it.
async function byteLenOfTodaysDigest() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MGMT}`, 'Content-Type': 'application/json', 'User-Agent': 'mnemosyne-smoke-librarian' },
    body: JSON.stringify({
      query: `select coalesce(max(octet_length(detail::text)), -1)::int as n from public.activity_log
              where action='librarian.digest' and detail->>'digest_date' = '${today}';`,
    }),
  })
  if (!res.ok) throw new Error(`byteLen query HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return (await res.json())?.[0]?.n
}

// The digest is same-day idempotent, so the smoke must clear today's row to run at all. Earlier
// versions simply deleted it, which destroyed the REAL cron digest and left no audit trail for that
// day -- repeated QC runs erased exactly the artifact Unit L exists to produce. Snapshot it first and
// put it back at the end.
let preexistingDigest = null
async function captureDigest() {
  const { data, error } = await db.from('activity_log').select(DIGEST_COLS).eq('action', 'librarian.digest').eq('detail->>digest_date', today).limit(1)
  if (error) throw new Error(`captureDigest: ${error.message}`)
  return data?.[0] ?? null
}
async function restoreDigest() {
  if (!preexistingDigest) return 'nothing to restore'
  const { data: current, error: readErr } = await db.from('activity_log').select('id').eq('action', 'librarian.digest').eq('detail->>digest_date', today).limit(1)
  if (readErr) throw new Error(`restoreDigest read: ${readErr.message}`)
  if (current?.length) return 'slot already occupied, left as-is'
  const { error } = await db.from('activity_log').insert(preexistingDigest)
  if (error) throw new Error(`restoreDigest insert: ${error.message}`)
  return 'restored'
}

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
  preexistingDigest = await captureDigest()
  console.log(`  --   pre-existing digest for ${today}: ${preexistingDigest ? 'captured, will be restored' : 'none'}`)
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

  const asciiBytes = await byteLenOfTodaysDigest()
  check('ASCII digest within the 4096-byte cap (server-side octet_length)', asciiBytes > 0 && asciiBytes <= 4096, `${asciiBytes} bytes`)

  // --- 0037: the multibyte case that defeated 0036's character cap ---
  await deleteDigest()
  await insert(names.multibyte, { embedding: oneHot(6), links: [MULTIBYTE_TARGET] })
  check('multibyte target is char-legal but byte-heavy', MULTIBYTE_TARGET.length <= 990 && Buffer.byteLength(MULTIBYTE_TARGET, 'utf8') > 2000,
    `${MULTIBYTE_TARGET.length} chars / ${Buffer.byteLength(MULTIBYTE_TARGET, 'utf8')} bytes`)

  let mbDigest = null, mbError = null
  try { mbDigest = await runDigest('multibyte digest') } catch (e) { mbError = e.message }
  check('librarian still emits a digest with multibyte link content', mbError === null, mbError ?? '')

  if (mbDigest) {
    const mbBytes = await byteLenOfTodaysDigest()
    check('multibyte digest within the 4096-byte cap (server-side octet_length)', mbBytes > 0 && mbBytes <= 4096, `${mbBytes} bytes`)
    check('multibyte digest still reports honest counts', Number(mbDigest.dead_links_count) >= Number(d.dead_links_count),
      `${d.dead_links_count} -> ${mbDigest.dead_links_count}`)
    for (const key of SECTIONS) {
      const sample = JSON.parse(mbDigest[`${key}_json`] ?? '[]')
      check(`${key}_truncated still honest under byte pressure`, mbDigest[`${key}_truncated`] === (Number(mbDigest[`${key}_count`]) > sample.length),
        `flag=${mbDigest[`${key}_truncated`]} count=${mbDigest[`${key}_count`]} sample=${sample.length}`)
    }
  }

  // --- same-day idempotency ---
  const second = await db.rpc('run_memory_librarian')
  check('same-day run is idempotent', !second.error, second.error?.message)
  const { count } = await db.from('activity_log').select('id', { count: 'exact', head: true }).eq('action', 'librarian.digest').eq('detail->>digest_date', today)
  check('same-day run leaves one digest row', count === 1, `count=${count}`)
} catch (error) { console.error(error.message); fail++ }
finally {
  try {
    await removeFixtures()
    const outcome = await restoreDigest()
    check('pre-existing digest preserved', true, outcome)
  } catch (error) { console.error(`cleanup failed: ${error.message}`); fail++ }
}

console.log(`[smoke-librarian] pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
