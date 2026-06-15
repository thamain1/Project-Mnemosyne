// Project 4ward — KEYLESS orchestration tests for runPersist (Aegis 0002 round-4 test-gap + round-5).
// Uses a mock rpc that records call order/payloads. Run: node scripts/test-ingest-orchestration.mjs

import { runPersist } from './lib/ingest-run.mjs'

const RUN = 'r1'
const MODEL = 'gemini-embedding-001'
const rec = (name) => ({ run_id: RUN, name, kind: 'reference', title: 't', body: 'b', links: [], source_path: `memory/${name}.md`, embedding_model: MODEL, embedding: '[]', chunks: [] })
const meta = (failed = 0) => ({ run_id: RUN, kind: 'memory', embed_counts: { accepted: 2, quarantined: 0, skipped: 0, failed, embedded_vectors: 2, chunk_rows: 0 } })
const records2 = [rec('a'), rec('b')]
const quiet = { error() {} }

function mockRpc(handlers) {
  const calls = []
  const fn = async (name, args) => { calls.push({ name, args }); const h = handlers[name]; return typeof h === 'function' ? h(args, calls) : (h ?? { data: null, error: null }) }
  fn.calls = calls
  return fn
}

let pass = 0, fail = 0
const ok = (l) => { console.log(`  ok    ${l}`); pass++ }
const bad = (l, m) => { console.error(`  FAIL  ${l}${m ? ' — ' + m : ''}`); fail++ }
const assert = (l, c, m) => (c ? ok(l) : bad(l, m))

console.log('[orch-test] keyless orchestration')

// 1. happy path: order + payloads
{
  const rpc = mockRpc({ start_ingestion_run: { data: 'db1', error: null }, ingest_memory_entry: { data: null, error: null }, finish_ingestion_run: { data: null, error: null } })
  const r = await runPersist({ records: records2, runMeta: meta(0), rpc, log: quiet })
  assert('happy: status success + finalized', r.status === 'success' && r.finalized)
  assert('happy: call order', rpc.calls.map((c) => c.name).join(',') === 'start_ingestion_run,ingest_memory_entry,ingest_memory_entry,finish_ingestion_run')
  assert('happy: start payload (p_kind=memory, embed_run_id)', rpc.calls[0].args.p_kind === 'memory' && rpc.calls[0].args.p_embed_run_id === RUN)
  assert('happy: ingest payload has run_id stripped', !('run_id' in rpc.calls[1].args.payload))
}
// 2. start fails -> no ingest, throws
{
  const rpc = mockRpc({ start_ingestion_run: { data: null, error: { message: 'boom' } } })
  let threw = false; try { await runPersist({ records: records2, runMeta: meta(0), rpc, log: quiet }) } catch { threw = true }
  assert('start-fail: throws', threw)
  assert('start-fail: NO ingest_memory_entry called', !rpc.calls.some((c) => c.name === 'ingest_memory_entry'))
}
// 3. all entries fail -> failed
{
  const rpc = mockRpc({ start_ingestion_run: { data: 'db', error: null }, ingest_memory_entry: { data: null, error: { message: 'x' } }, finish_ingestion_run: { data: null, error: null } })
  const r = await runPersist({ records: records2, runMeta: meta(0), rpc, log: quiet })
  assert('all-fail: status failed', r.status === 'failed')
}
// 4. embed failure + all persist -> partial (not success)
{
  const rpc = mockRpc({ start_ingestion_run: { data: 'db', error: null }, ingest_memory_entry: { data: null, error: null }, finish_ingestion_run: { data: null, error: null } })
  const r = await runPersist({ records: records2, runMeta: meta(1), rpc, log: quiet })
  assert('embed-failure: status partial', r.status === 'partial')
}
// 5. finalize fails -> not finalized, no false success
{
  const rpc = mockRpc({ start_ingestion_run: { data: 'db', error: null }, ingest_memory_entry: { data: null, error: null }, finish_ingestion_run: { data: null, error: { message: 'fin' } } })
  const r = await runPersist({ records: records2, runMeta: meta(0), rpc, log: quiet })
  assert('finalize-fail: finalized=false', r.finalized === false && r.finalizeError === 'fin')
}
// 6. fatal mid-run -> best-effort finalize 'failed' + rethrow original
{
  let finArgs = null
  const rpc = mockRpc({ start_ingestion_run: { data: 'db', error: null }, ingest_memory_entry: () => { throw new Error('fatal') }, finish_ingestion_run: (a) => { finArgs = a; return { data: null, error: null } } })
  let err = null; try { await runPersist({ records: records2, runMeta: meta(0), rpc, log: quiet }) } catch (e) { err = e }
  assert('fatal: rethrows original error', err && err.message === 'fatal')
  assert('fatal: best-effort finalized as failed', finArgs && finArgs.p_status === 'failed')
}

console.log(`[orch-test] pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
