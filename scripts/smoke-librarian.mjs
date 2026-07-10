// Unit L live smoke. Run only after migration 0034 is applied:
// node --env-file=.env.local scripts/smoke-librarian.mjs
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
const vector = `[${Array.from({ length: 768 }, (_, i) => i === 0 ? '1' : '0').join(',')}]`
let pass = 0, fail = 0
function check(label, ok, detail = '') { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`) }
async function removeFixtures() {
  await db.from('activity_log').delete().eq('action', 'librarian.digest').like('detail->>source', 'smoke')
  await db.from('memory_entries').delete().in('name', Object.values(names))
}
async function insert(name, extra = {}) {
  const { error } = await db.from('memory_entries').insert({ name, kind: 'reference', title: name, body: `Smoke fixture ${name}`, links: extra.links ?? [], source_path: extra.source_path ?? `mcp/${name}`, embedding_model: 'gemini-embedding-001', embedding: extra.embedding ?? vector, tags: extra.tags ?? [], verified_at: extra.verified_at ?? new Date().toISOString(), archived: extra.archived ?? false })
  if (error) throw new Error(`fixture insert ${name}: ${error.message}`)
}

try {
  await removeFixtures()
  await insert(names.stale, { verified_at: new Date(Date.now() - 7 * 30 * 24 * 60 * 60 * 1000).toISOString() })
  await insert(names.dupA); await insert(names.dupB)
  await insert(names.dead, { links: [`${prefix}-missing`] })
  for (const name of [names.agentA, names.agentB, names.agentC]) await insert(name, { source_path: `agent/smoke-client/${name}`, tags: ['client:smoke-client'] })

  const first = await db.rpc('run_memory_librarian')
  check('run_memory_librarian executes', !first.error, first.error?.message)
  const { data: rows, error: readError } = await db.from('activity_log').select('id, detail').eq('action', 'librarian.digest').order('created_at', { ascending: false }).limit(1)
  check('digest activity row exists', !readError && rows?.length === 1, readError?.message)
  const detail = rows?.[0]?.detail ?? {}
  for (const key of ['stale_json', 'near_dups_json', 'dead_links_json', 'consolidation_json']) check(`digest has ${key} section`, typeof detail[key] === 'string')
  check('stale fixture reported', JSON.parse(detail.stale_json ?? '[]').some((x) => x.name === names.stale))
  check('dead link fixture reported', JSON.parse(detail.dead_links_json ?? '[]').some((x) => x.source === names.dead))
  check('consolidation group reported', JSON.parse(detail.consolidation_json ?? '[]').some((x) => x.tag === 'client:smoke-client'))
  const second = await db.rpc('run_memory_librarian')
  check('same-day run is idempotent', !second.error, second.error?.message)
  const { count } = await db.from('activity_log').select('id', { count: 'exact', head: true }).eq('action', 'librarian.digest').eq('detail->>digest_date', detail.digest_date)
  check('same-day run leaves one digest row', count === 1, `count=${count}`)
} catch (error) { console.error(error.message); fail++ }
finally { try { await removeFixtures() } catch (error) { console.error(`cleanup failed: ${error.message}`); fail++ } }

console.log(`[smoke-librarian] pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
