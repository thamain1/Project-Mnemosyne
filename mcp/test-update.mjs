// Mnemosyne — keyless tests for the update write slice. Run: node test-update.mjs
// No network, no DB, no keys: embedDoc/rpc mocked. Mirrors test-remember.mjs discipline.
import {
  validateUpdateArgs, buildUpdatePayload, runUpdate, MAX_CHANGE_REASON_LEN,
} from './lib/update-core.mjs'
import { MAX_TITLE_LEN, MAX_BODY_LEN } from './lib/remember-core.mjs'

let pass = 0, fail = 0
function check(name, cond) { if (cond) { pass++; console.log(`  ok    ${name}`) } else { fail++; console.log(`  FAIL  ${name}`) } }
async function throwsAsync(fn, frag) {
  try { await fn(); return false } catch (e) { return frag ? String(e.message).includes(frag) : true }
}
function throwsSync(fn, frag) {
  try { fn(); return false } catch (e) { return frag ? String(e.message).includes(frag) : true }
}
const vec768 = (fill = 1) => Array.from({ length: 768 }, () => fill)
const validLiteral = '[' + vec768().map((x) => x / Math.sqrt(768)).join(',') + ']'
const TS = '2026-06-16T00:00:00.000Z'
// expected_updated_at is MANDATORY (Aegis 0022 #1) — baked into the canonical "good" args.
const goodArgs = { name: 'intellioptics-2-5', title: 'IntelliOptics 2.5', body: 'Revised detail, folding in the old June-16 notes.', kind: 'project', expected_updated_at: TS }
const ACTOR = '11111111-1111-1111-1111-111111111111'

// ---- validateUpdateArgs ----
check('rejects non-object', throwsSync(() => validateUpdateArgs('x'), 'must be an object'))
check('rejects array', throwsSync(() => validateUpdateArgs([]), 'must be an object'))
check('rejects unexpected key', throwsSync(() => validateUpdateArgs({ ...goodArgs, foo: 1 }), 'unexpected argument'))
check('rejects missing name', throwsSync(() => validateUpdateArgs({ title: 't', body: 'b', kind: 'project' }), 'name'))
check('rejects name slugifying to empty', throwsSync(() => validateUpdateArgs({ ...goodArgs, name: '!!!' }), 'slugifies to empty'))
check('rejects missing title', throwsSync(() => validateUpdateArgs({ name: 'n', body: 'b', kind: 'project' }), 'title'))
check('rejects empty body', throwsSync(() => validateUpdateArgs({ name: 'n', title: 't', body: '', kind: 'project' }), 'body'))
check('rejects long title', throwsSync(() => validateUpdateArgs({ ...goodArgs, title: 'x'.repeat(MAX_TITLE_LEN + 1) }), 'exceeds'))
check('rejects long body', throwsSync(() => validateUpdateArgs({ ...goodArgs, body: 'x'.repeat(MAX_BODY_LEN + 1) }), 'exceeds'))
check('rejects bad kind', throwsSync(() => validateUpdateArgs({ ...goodArgs, kind: 'nope' }), 'kind'))
check('rejects non-string change_reason', throwsSync(() => validateUpdateArgs({ ...goodArgs, change_reason: 5 }), 'change_reason'))
check('rejects long change_reason', throwsSync(() => validateUpdateArgs({ ...goodArgs, change_reason: 'x'.repeat(MAX_CHANGE_REASON_LEN + 1) }), 'exceeds'))
check('rejects missing expected_updated_at (mandatory)', throwsSync(() => { const { expected_updated_at, ...rest } = goodArgs; return validateUpdateArgs(rest) }, 'required'))
check('rejects non-string expected_updated_at', throwsSync(() => validateUpdateArgs({ ...goodArgs, expected_updated_at: 5 }), 'required'))
check('rejects empty expected_updated_at', throwsSync(() => validateUpdateArgs({ ...goodArgs, expected_updated_at: '   ' }), 'required'))
check('rejects invalid expected_updated_at', throwsSync(() => validateUpdateArgs({ ...goodArgs, expected_updated_at: 'not-a-date' }), 'valid ISO'))
const v1 = validateUpdateArgs(goodArgs)
check('accepts good args, normalizes name', v1.name === 'intellioptics-2-5' && v1.kind === 'project')
check('normalizes sloppy name', validateUpdateArgs({ ...goodArgs, name: 'IntelliOptics 2.5' }).name === 'intellioptics-2-5')
check('preserves expected_updated_at', v1.expected_updated_at === TS)
check('blank change_reason → undefined', validateUpdateArgs({ ...goodArgs, change_reason: '   ' }).change_reason === undefined)

// ---- buildUpdatePayload (no source_path — provenance immutable on update) ----
{
  const embedDoc = async () => validLiteral
  const single = await buildUpdatePayload({ title: 'T', body: 'short body [[onthehash]]', kind: 'project', name: 'x' }, embedDoc)
  check('buildUpdatePayload single embedding', single.embedding === validLiteral && single.chunks.length === 0)
  check('buildUpdatePayload has NO source_path', !('source_path' in single))
  check('buildUpdatePayload extracts links', JSON.stringify(single.links) === JSON.stringify(['onthehash']))
  check('buildUpdatePayload pins model', single.embedding_model === 'gemini-embedding-001')
}

// ---- runUpdate orchestration ----
{
  const embedDoc = async () => validLiteral
  const rpcOk = async () => ({ data: { id: 'e1', name: 'intellioptics-2-5', version_no: 3 }, error: null })

  // fail closed without a valid operator actor
  check('fails closed without actorId', await throwsAsync(() => runUpdate(goodArgs, { embedDoc, rpc: rpcOk }), 'operator actor'))
  check('fails closed with non-uuid actorId', await throwsAsync(() => runUpdate(goodArgs, { embedDoc, rpc: rpcOk, actorId: 'nope' }), 'operator actor'))

  // secret-bearing body refused BEFORE embed/rpc
  let embedded = false, rpcCalled = false
  const embedSpy = async () => { embedded = true; return validLiteral }
  const rpcSpy = async () => { rpcCalled = true; return { data: {}, error: null } }
  check('refuses secret-bearing content', await throwsAsync(() => runUpdate({ ...goodArgs, body: 'sbp_' + 'a'.repeat(40) }, { embedDoc: embedSpy, rpc: rpcSpy, actorId: ACTOR }), 'refused'))
  check('no embed or rpc on secret', embedded === false && rpcCalled === false)

  // secret in change_reason also refused
  check('refuses secret in change_reason', await throwsAsync(() => runUpdate({ ...goodArgs, change_reason: 'AIza' + 'B'.repeat(35) }, { embedDoc, rpc: rpcOk, actorId: ACTOR }), 'refused'))

  // happy path: calls update_memory with payload + actor + audit + concurrency token
  let fnSeen, argsSeen
  const rpc = async (fn, args) => { fnSeen = fn; argsSeen = args; return { data: { id: 'e1', name: 'intellioptics-2-5', version_no: 3 }, error: null } }
  const msg = await runUpdate({ ...goodArgs, change_reason: 'fold in June-16 detail' }, { embedDoc, rpc, actorId: ACTOR })
  check('calls update_memory', fnSeen === 'update_memory')
  check('passes operator actor', argsSeen.p_actor === ACTOR)
  check('passes mandatory expected_updated_at token', argsSeen.p_expected_updated_at === TS)
  check('payload keys correct (no source_path)', JSON.stringify(Object.keys(argsSeen.p_payload).sort()) === JSON.stringify(['body', 'chunks', 'embedding', 'embedding_model', 'kind', 'links', 'name', 'title']))
  check('audit = safe metadata + reason, no body', argsSeen.p_audit.kind === 'project' && typeof argsSeen.p_audit.chunks === 'number' && argsSeen.p_audit.change_reason === 'fold in June-16 detail' && !('body' in argsSeen.p_audit))
  check('success message notes versioned/reversible', msg.includes('version 3') && msg.includes('reversible'))

  // fails closed when expected_updated_at omitted (mandatory) — never reaches embed/rpc
  let embeddedNoTs = false
  const { expected_updated_at, ...noTs } = goodArgs
  check('fails closed without expected_updated_at', await throwsAsync(() => runUpdate(noTs, { embedDoc: async () => { embeddedNoTs = true; return validLiteral }, rpc, actorId: ACTOR }), 'required'))
  check('no embed without expected_updated_at', embeddedNoTs === false)

  // rpc error surfaces (e.g. concurrency conflict raised by the RPC)
  const rpcConflict = async () => ({ data: null, error: { message: 'changed since you read it' } })
  check('surfaces concurrency conflict from rpc', await throwsAsync(() => runUpdate(goodArgs, { embedDoc, rpc: rpcConflict, actorId: ACTOR }), 'update_memory error'))

  // validation error short-circuits before embed
  let embedded2 = false
  check('rejects bad args before embed', await throwsAsync(() => runUpdate({ ...goodArgs, title: '' }, { embedDoc: async () => { embedded2 = true; return validLiteral }, rpc, actorId: ACTOR }), 'title'))
  check('no embed on invalid args', embedded2 === false)

  // fan-out bound: oversized body rejected BEFORE any embed
  let embedded3 = false
  check('rejects oversized body before embed', await throwsAsync(() => runUpdate({ ...goodArgs, body: 'z'.repeat(80000) }, { embedDoc: async () => { embedded3 = true; return validLiteral }, rpc, actorId: ACTOR }), 'too large'))
  check('no embed when over chunk cap', embedded3 === false)
}

console.log(`[update-test] pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
