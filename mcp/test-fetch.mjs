// Mnemosyne — keyless tests for the fetch read-body slice. Run: node test-fetch.mjs
// No network, no DB, no keys: rpc is mocked. Mirrors test-recall.mjs / test-remember.mjs discipline.
import { validateFetchArgs, formatEntry, runFetch, redactSecrets, REDACTION, MAX_NAME_LEN } from './lib/fetch-core.mjs'

let pass = 0, fail = 0
function check(name, cond) { if (cond) { pass++; console.log(`  ok    ${name}`) } else { fail++; console.log(`  FAIL  ${name}`) } }
async function throwsAsync(fn, frag) {
  try { await fn(); return false } catch (e) { return frag ? String(e.message).includes(frag) : true }
}
function throwsSync(fn, frag) {
  try { fn(); return false } catch (e) { return frag ? String(e.message).includes(frag) : true }
}

const row = {
  name: 'intellioptics-2-5', kind: 'project', title: 'IntelliOptics 2.5',
  body: 'The deep June-16 detail lives here.', links: ['mavenpark', 'intelliservice'],
  source_path: 'memory/intellioptics-2.5.md', sensitivity: 'team', updated_at: '2026-06-16T00:00:00Z',
}

// ---- validateFetchArgs ----
check('rejects non-object', throwsSync(() => validateFetchArgs('x'), 'must be an object'))
check('rejects array', throwsSync(() => validateFetchArgs([]), 'must be an object'))
check('rejects null', throwsSync(() => validateFetchArgs(null), 'must be an object'))
check('rejects unexpected key', throwsSync(() => validateFetchArgs({ name: 'x', foo: 1 }), 'unexpected argument'))
check('rejects missing name', throwsSync(() => validateFetchArgs({}), 'name'))
check('rejects empty name', throwsSync(() => validateFetchArgs({ name: '   ' }), 'name'))
check('rejects non-string name', throwsSync(() => validateFetchArgs({ name: 5 }), 'name'))
check('rejects name slugifying to empty', throwsSync(() => validateFetchArgs({ name: '!!!' }), 'slugifies to empty'))
check('rejects over-long name', throwsSync(() => validateFetchArgs({ name: 'a'.repeat(MAX_NAME_LEN + 1) }), 'exceeds'))
check('exact slug is idempotent', validateFetchArgs({ name: 'intellioptics-2-5' }).name === 'intellioptics-2-5')
check('sloppy name normalizes to slug', validateFetchArgs({ name: 'IntelliOptics 2.5' }).name === 'intellioptics-2-5')

// ---- formatEntry ----
{
  const out = formatEntry(row)
  check('formatEntry includes title header', out.startsWith('# IntelliOptics 2.5'))
  check('formatEntry includes name/kind/sensitivity', out.includes('name: intellioptics-2-5') && out.includes('kind: project') && out.includes('sensitivity: team'))
  check('formatEntry includes provenance + freshness', out.includes('source: memory/intellioptics-2.5.md') && out.includes('updated: 2026-06-16'))
  check('formatEntry renders links', out.includes('[[mavenpark]]') && out.includes('[[intelliservice]]'))
  check('formatEntry includes the full body', out.includes('The deep June-16 detail lives here.'))
  check('formatEntry returns null for missing row', formatEntry(null) === null)
  const noLinks = formatEntry({ ...row, links: [] })
  check('formatEntry omits links line when none', !noLinks.includes('links:'))
}

// ---- redactSecrets / egress secret scan (Aegis 0022 #2) ----
{
  check('redactSecrets clean text unchanged', redactSecrets('a normal note').count === 0)
  check('redactSecrets handles null/empty', redactSecrets(null).count === 0 && redactSecrets('').count === 0)
  const secret = 'token sbp_' + 'a'.repeat(40) + ' end'
  const r = redactSecrets(secret)
  check('redactSecrets redacts sbp_ token', r.count === 1 && r.text.includes(REDACTION) && !r.text.includes('sbp_aaaa'))
  const multi = redactSecrets('AIza' + 'B'.repeat(35) + ' and sk_live_' + 'c'.repeat(20))
  check('redactSecrets redacts multiple spans', multi.count === 2 && !multi.text.includes('AIzaB') && !multi.text.includes('sk_live_c'))

  // formatEntry redacts a contaminated body + emits a warning, keeps the rest of the body
  const dirty = formatEntry({ ...row, body: 'safe text sbp_' + 'a'.repeat(40) + ' more safe text' })
  check('formatEntry redacts secret in body', dirty.includes(REDACTION) && !dirty.includes('sbp_aaaa'))
  check('formatEntry warns on redaction', dirty.includes('REDACTED on read') && dirty.includes('contaminated'))
  check('formatEntry keeps surrounding body text', dirty.includes('safe text') && dirty.includes('more safe text'))
  check('formatEntry no warning when clean', !formatEntry(row).includes('REDACTED on read'))

  // runFetch path also redacts (egress, not just formatEntry)
  const rpcDirty = async () => ({ data: [{ ...row, body: 'leak sbp_' + 'a'.repeat(40) }], error: null })
  const out = await runFetch({ name: 'x' }, { rpc: rpcDirty })
  check('runFetch redacts on egress', out.includes(REDACTION) && !out.includes('sbp_aaaa') && out.includes('REDACTED on read'))
}

// ---- runFetch orchestration ----
{
  // happy path: table-returning RPC → array of rows; returns the full formatted body
  let fnSeen, argsSeen
  const rpc = async (fn, args) => { fnSeen = fn; argsSeen = args; return { data: [row], error: null } }
  const out = await runFetch({ name: 'intellioptics-2-5' }, { rpc })
  check('runFetch calls get_memory_entry', fnSeen === 'get_memory_entry')
  check('runFetch passes normalized p_name', argsSeen.p_name === 'intellioptics-2-5')
  check('runFetch returns the body', out.includes('The deep June-16 detail lives here.'))

  // normalizes sloppy name before the RPC
  const out2 = await runFetch({ name: 'IntelliOptics 2.5' }, { rpc })
  check('runFetch normalizes sloppy name', argsSeen.p_name === 'intellioptics-2-5' && out2.includes('IntelliOptics 2.5'))

  // not found (empty array) → friendly miss message, not a throw
  const rpcEmpty = async () => ({ data: [], error: null })
  const miss = await runFetch({ name: 'no-such-entry' }, { rpc: rpcEmpty })
  check('runFetch reports a clean miss', miss.includes('No memory entry named "no-such-entry"'))

  // handles a non-array data shape defensively
  const rpcObj = async () => ({ data: row, error: null })
  check('runFetch handles object data shape', (await runFetch({ name: 'x' }, { rpc: rpcObj })).includes('IntelliOptics 2.5'))

  // rpc error surfaces
  const rpcErr = async () => ({ data: null, error: { message: 'boom' } })
  check('runFetch surfaces rpc error', await throwsAsync(() => runFetch({ name: 'x' }, { rpc: rpcErr }), 'get_memory_entry error'))

  // bad args short-circuit before any rpc call
  let called = false
  const rpcSpy = async () => { called = true; return { data: [row], error: null } }
  check('runFetch rejects bad args', await throwsAsync(() => runFetch({ name: '' }, { rpc: rpcSpy }), 'name'))
  check('runFetch no rpc on invalid args', called === false)
}

console.log(`[fetch-test] pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
