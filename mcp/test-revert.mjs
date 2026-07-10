// Mnemosyne - keyless tests for Unit L revert. No network, DB, or credentials.
import { validateRevertArgs, runRevert } from './lib/revert-core.mjs'

let pass = 0, fail = 0
function check(name, condition) { condition ? pass++ : fail++; console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${name}`) }
async function throwsAsync(fn, fragment) {
  try { await fn(); return false } catch (error) { return fragment ? String(error.message).includes(fragment) : true }
}
function throwsSync(fn, fragment) {
  try { fn(); return false } catch (error) { return fragment ? String(error.message).includes(fragment) : true }
}

const ACTOR = '11111111-1111-1111-1111-111111111111'
const TS = '2026-07-10T12:00:00.000Z'
const literal = '[' + Array.from({ length: 768 }, () => 1 / Math.sqrt(768)).join(',') + ']'
const good = { name: 'project-mnemosyne', version_no: 2, reason: 'restore approved baseline' }
const current = { name: 'project-mnemosyne', title: 'Current', body: 'Current body', kind: 'project', updated_at: TS }
const version = { name: 'project-mnemosyne', title: 'Prior title', body: 'Prior body [[linked-entry]]', kind: 'reference', version_no: 2 }

check('rejects non-object args', throwsSync(() => validateRevertArgs(null), 'must be an object'))
check('rejects unexpected arg', throwsSync(() => validateRevertArgs({ ...good, extra: true }), 'unexpected argument'))
check('rejects missing name', throwsSync(() => validateRevertArgs({ version_no: 2 }), 'name'))
check('rejects empty-slug name', throwsSync(() => validateRevertArgs({ name: '!!!', version_no: 2 }), 'slugifies to empty'))
check('rejects non-integer version', throwsSync(() => validateRevertArgs({ name: 'x', version_no: 1.5 }), 'positive 32-bit integer'))
check('rejects zero version', throwsSync(() => validateRevertArgs({ name: 'x', version_no: 0 }), 'positive 32-bit integer'))
check('rejects non-string reason', throwsSync(() => validateRevertArgs({ ...good, reason: 7 }), 'reason'))
check('normalizes name and reason', validateRevertArgs({ name: 'Project Mnemosyne', version_no: 2, reason: '  baseline  ' }).change_reason === 'revert to v2: baseline')
check('allows omitted reason', validateRevertArgs({ name: 'x', version_no: 1 }).change_reason === 'revert to v1')

function makeRpc({ currentRow = current, versionRow = version, currentError = null, versionError = null, updateError = null } = {}) {
  const calls = []
  const rpc = async (fn, args) => {
    calls.push({ fn, args })
    if (fn === 'get_memory_entry') return { data: currentRow ? [currentRow] : [], error: currentError }
    if (fn === 'get_memory_version') return { data: versionRow ? [versionRow] : [], error: versionError }
    if (fn === 'update_memory') return { data: { version_no: 3 }, error: updateError }
    throw new Error(`unexpected RPC ${fn}`)
  }
  return { rpc, calls }
}

check('fails closed without operator actor', await throwsAsync(() => runRevert(good, { embedDoc: async () => literal, rpc: makeRpc().rpc }), 'operator actor'))

{
  const { rpc, calls } = makeRpc()
  const embedded = []
  const message = await runRevert(good, { embedDoc: async (text) => { embedded.push(text); return literal }, rpc, actorId: ACTOR })
  check('reads current entry before requested version', calls[0].fn === 'get_memory_entry' && calls[1].fn === 'get_memory_version')
  check('passes requested version number to RPC', calls[1].args.p_version_no === 2)
  check('reuses update payload builder embedding shape', embedded[0] === 'Prior title\n\nPrior body [[linked-entry]]')
  const update = calls.find((call) => call.fn === 'update_memory')
  check('passes current updated_at as concurrency token', update?.args.p_expected_updated_at === TS)
  check('reverts updatable version fields including kind', update?.args.p_payload.title === version.title && update?.args.p_payload.body === version.body && update?.args.p_payload.kind === version.kind)
  check('rebuilds links through shared update builder', JSON.stringify(update?.args.p_payload.links) === JSON.stringify(['linked-entry']))
  check('uses canonical revert change reason', update?.args.p_audit.change_reason === 'revert to v2: restore approved baseline')
  check('success reports target version without body', message.includes('version 2') && !message.includes(version.body))
}

{
  let embedded = false
  const contaminated = { ...version, version_no: 1, body: `incident snapshot sk_live_${'x'.repeat(24)}` }
  const { rpc, calls } = makeRpc({ versionRow: contaminated })
  check('refuses secret-contaminated historical version', await throwsAsync(() => runRevert({ name: good.name, version_no: 1 }, { embedDoc: async () => { embedded = true; return literal }, rpc, actorId: ACTOR }), 'version 1'))
  check('secret refusal occurs before embed/update', embedded === false && !calls.some((call) => call.fn === 'update_memory'))
}

check('propagates current-entry RPC error', await throwsAsync(() => runRevert(good, { embedDoc: async () => literal, rpc: makeRpc({ currentError: { message: 'current read failed' } }).rpc, actorId: ACTOR }), 'get_memory_entry error'))
check('propagates version RPC error', await throwsAsync(() => runRevert(good, { embedDoc: async () => literal, rpc: makeRpc({ versionError: { message: 'version read failed' } }).rpc, actorId: ACTOR }), 'get_memory_version error'))
check('propagates update/concurrency RPC error', await throwsAsync(() => runRevert(good, { embedDoc: async () => literal, rpc: makeRpc({ updateError: { message: 'changed since you read it' } }).rpc, actorId: ACTOR }), 'update_memory error'))

console.log(`[revert-test] pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
