// Mnemosyne — KEYLESS usage-telemetry core tests (thread 0025 P5-TELEMETRY). No network, no DB, no keys.
// Run: node mcp/test-usage.mjs

import { logMcpUsage, TELEMETRY_ON } from './lib/usage-core.mjs'

let pass = 0, fail = 0
const ok = (l) => { console.log(`  ok    ${l}`); pass++ }
const bad = (l, m) => { console.error(`  FAIL  ${l}${m ? ' — ' + m : ''}`); fail++ }
const accepts = async (l, fn) => { try { await fn(); ok(l + ' (ok)') } catch (e) { bad(l, e.message) } }

console.log('[usage-test] keyless')

// --- TELEMETRY_ON reflects env at import time (default on) ---
await accepts('TELEMETRY_ON defaults true when MNEMOSYNE_TELEMETRY unset', () => {
  if (TELEMETRY_ON !== (process.env.MNEMOSYNE_TELEMETRY !== '0')) throw new Error('mismatch')
})

// --- logMcpUsage calls rpc('log_usage', ...) with the expected shape ---
await accepts('logMcpUsage calls log_usage with source=mcp + given fields', async () => {
  let call
  const rpc = async (n, a) => { call = { n, a }; return { data: 'id', error: null } }
  await logMcpUsage(rpc, { actorId: 'uid-1', tool: 'recall', bytesIn: 10, bytesOut: 20, ok: true })
  if (call.n !== 'log_usage') throw new Error('rpc name')
  if (call.a.p_source !== 'mcp') throw new Error('source')
  if (call.a.p_tool !== 'recall') throw new Error('tool')
  if (call.a.p_actor !== 'uid-1') throw new Error('actor')
  if (call.a.p_bytes_in !== 10 || call.a.p_bytes_out !== 20) throw new Error('bytes')
  if (call.a.p_ok !== true) throw new Error('ok')
})

// --- null/falsy actorId -> p_actor null (no operator configured) ---
await accepts('logMcpUsage coerces missing actorId to null', async () => {
  let call
  const rpc = async (n, a) => { call = a; return { data: 'id', error: null } }
  await logMcpUsage(rpc, { actorId: undefined, tool: 'fetch', bytesIn: 1, bytesOut: 1, ok: true })
  if (call.p_actor !== null) throw new Error('actor not null')
})

// --- best-effort: rpc error never throws ---
await accepts('logMcpUsage swallows rpc error (never throws)', async () => {
  const rpc = async () => { throw new Error('db down') }
  await logMcpUsage(rpc, { actorId: 'uid-1', tool: 'recall', bytesIn: 1, bytesOut: 1, ok: true })
})

// --- best-effort: rpc returning {error} (not throwing) never throws either ---
await accepts('logMcpUsage swallows rpc {error} result (never throws)', async () => {
  const rpc = async () => ({ data: null, error: { message: 'grant denied' } })
  await logMcpUsage(rpc, { actorId: 'uid-1', tool: 'recall', bytesIn: 1, bytesOut: 1, ok: true })
})

console.log(`[usage-test] pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
