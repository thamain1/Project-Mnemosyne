#!/usr/bin/env node
// Mnemosyne — live acceptance battery for the Agent Context & Outcome API
// (docs/WORK-ORDER-AGENT-API.md, migration 0031). Exercises the exact checklist in the WO's
// "Verify + close out" section, including the cross-client-leakage negative (the one unforgivable
// bug this design exists to prevent) and the memory-write path (which Atlas's pre-apply review fixed
// a real bug in — see docs/WORK-ORDER-AGENT-API.md Receiver log).
//
// Uses DISPOSABLE test agent_clients (never "dunaway-isb-demo" — that real client is provisioned
// separately, out-of-band, per Jesse's 2026-07-06 instruction). All fixtures are cleaned up at the end
// (try/finally) regardless of pass/fail.
//
// Run: node --env-file=.env.local scripts/smoke-agent-api.mjs

import { createClient } from '@supabase/supabase-js'
import { randomBytes, randomUUID, createHash } from 'node:crypto'

const BASE = process.env.SMOKE_BASE || 'https://project-mnemosyne.pages.dev'
const CTX_URL = `${BASE}/api/agent-context`
const OUT_URL = `${BASE}/api/agent-outcome`
const URL = process.env.VITE_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !SERVICE || !PUB) { console.error('missing env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / PUBLISHABLE)'); process.exit(1) }

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const anonClient = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } })
const stamp = process.env.SMOKE_STAMP || String(Date.now())
const SYSTEM_ACTOR_ID = '1788c353-8921-418b-9db4-fa8ca388c1b0'

let pass = 0, fail = 0
function check(name, ok, extra = '') { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

function mintTestToken() {
  const token = 'agt_test_' + randomBytes(24).toString('base64url')
  return { token, hash: createHash('sha256').update(token).digest('hex') }
}

async function createAgentClient(slug, displayName, { active = true } = {}) {
  const { token, hash } = mintTestToken()
  const { error } = await admin.from('agent_clients').insert({ client_slug: slug, display_name: displayName, token_hash: hash, is_active: active })
  if (error) throw new Error(`createAgentClient(${slug}): ${error.message}`)
  return token
}

async function createAuthenticatedRpcClient() {
  const created = await admin.auth.admin.createUser({ email: authEmail, password: authPassword, email_confirm: true })
  if (created.error) throw new Error(`create authenticated rpc user: ${created.error.message}`)
  authUid = created.data.user.id
  const authClient = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } })
  const signed = await authClient.auth.signInWithPassword({ email: authEmail, password: authPassword })
  if (signed.error || !signed.data?.session?.access_token) throw new Error(`sign in authenticated rpc user: ${signed.error?.message}`)
  return createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { authorization: `Bearer ${signed.data.session.access_token}` } } })
}

const denied = (res) => !!res.error && (res.error.code === '42501' || /permission denied/i.test(res.error.message ?? ''))
async function call(url, token, body) {
  const headers = { 'content-type': 'application/json' }
  if (token !== null) headers.authorization = `Bearer ${token}`
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  let json = null
  const text = await res.text()
  try { json = text ? JSON.parse(text) : null } catch { /* tolerated */ }
  return { status: res.status, json, text }
}

const slugA = `smoke-agent-a-${stamp}`
const slugB = `smoke-agent-b-${stamp}`
const slugC = `smoke-agent-c-${stamp}` // deactivated
const slugD = `smoke-agent-d-${stamp}` // never gets any memories — null-context case
const customerId = randomUUID()
const techId = randomUUID()
const otherCustomerId = randomUUID() // used only in client B's SQL-layer leakage-bait memory
const authEmail = `smoke-agent-auth-${stamp}@mnemosyne.test`
const authPassword = 'Smoke!' + Math.abs(URL.length * 7919).toString(36) + 'xZ9'
let authUid

async function memoryCountFor(slug) {
  const { count, error } = await admin.from('memory_entries').select('id', { count: 'exact', head: true }).contains('tags', [`client:${slug}`])
  if (error) throw new Error(`memoryCountFor(${slug}): ${error.message}`)
  return count ?? 0
}

async function cleanup() {
  await admin.from('memory_entries').delete().or(`tags.cs.{client:${slugA}},tags.cs.{client:${slugB}}`)
  await admin.from('activity_log').delete().in('actor_id', [SYSTEM_ACTOR_ID]).contains('detail', { client_slug: slugA })
  await admin.from('activity_log').delete().in('actor_id', [SYSTEM_ACTOR_ID]).contains('detail', { client_slug: slugB })
  await admin.from('rate_limits').delete().eq('actor_id', SYSTEM_ACTOR_ID).in('bucket', [
    `agent_context:${slugA}`, `agent_outcome:${slugA}`, `agent_context:${slugB}`, `agent_outcome:${slugB}`,
    `agent_context:${slugC}`, `agent_context:${slugD}`,
  ])
  await admin.from('agent_clients').delete().in('client_slug', [slugA, slugB, slugC, slugD])
  if (authUid) await admin.auth.admin.deleteUser(authUid)
}

async function main() {
  const tokenA = await createAgentClient(slugA, `Smoke test A ${stamp}`)
  const tokenB = await createAgentClient(slugB, `Smoke test B ${stamp}`)
  const tokenC = await createAgentClient(slugC, `Smoke test C (deactivated) ${stamp}`, { active: false })
  const tokenD = await createAgentClient(slugD, `Smoke test D (no memories) ${stamp}`)
  const authenticatedRpcClient = await createAuthenticatedRpcClient()

  // ── auth negatives (both endpoints, fail-closed, identical shape) ──────────────────────────────
  { const r = await call(CTX_URL, null, { customer_id: customerId, tech_ids: [] }); check('agent-context: missing bearer -> 401', r.status === 401) }
  { const r = await call(CTX_URL, 'agt_garbage_not_a_real_token', { customer_id: customerId, tech_ids: [] }); check('agent-context: unknown token -> 401', r.status === 401) }
  { const r = await call(CTX_URL, tokenC, { customer_id: customerId, tech_ids: [] }); check('agent-context: deactivated client token -> 401', r.status === 401) }
  { const r = await call(OUT_URL, null, { event_type: 'note', summary: 'x' }); check('agent-outcome: missing bearer -> 401', r.status === 401) }
  { const r = await call(OUT_URL, tokenC, { event_type: 'note', summary: 'x' }); check('agent-outcome: deactivated client token -> 401', r.status === 401) }

  // ── agent-context input validation ──────────────────────────────────────────────────────────────
  { const r = await call(CTX_URL, tokenA, { customer_id: 'not-a-uuid', tech_ids: [] }); check('agent-context: bad customer_id -> 400', r.status === 400) }
  { const r = await call(CTX_URL, tokenA, { customer_id: customerId, tech_ids: [], extra: 1 }); check('agent-context: unexpected field -> 400', r.status === 400) }
  { const r = await call(CTX_URL, tokenD, { customer_id: customerId, tech_ids: [] }); check('agent-context: no memories -> context null', r.status === 200 && r.json?.context === null, JSON.stringify(r.json)) }

  // ── agent-outcome input validation ──────────────────────────────────────────────────────────────
  { const r = await call(OUT_URL, tokenA, { event_type: 'banana', summary: 'x' }); check('agent-outcome: bad event_type -> 400', r.status === 400) }
  { const r = await call(OUT_URL, tokenA, { event_type: 'note', summary: 'x'.repeat(501) }); check('agent-outcome: oversized summary -> 400', r.status === 400) }
  { const r = await call(OUT_URL, tokenA, { event_type: 'note', summary: 'leaked key AKIAABCDEFGHIJKLMNOP in the wild' }); check('agent-outcome: secret-looking summary -> rejected 400', r.status === 400, r.json?.error) }
  { const r = await call(OUT_URL, tokenA, { event_type: 'note' }); check('agent-outcome: missing summary -> 400', r.status === 400) }

  const before = await memoryCountFor(slugA)

  // ── the memory-write path (exercises Atlas's allowlist fix) — 3 real-shaped memories for client A ──
  const r1 = await call(OUT_URL, tokenA, {
    event_type: 'note', customer_id: customerId, customer_name: 'Acme Corp',
    summary: 'Customer prefers morning appointments only; refuses Saturday visits.',
  })
  check('agent-outcome: note w/ customer -> 200 ok', r1.status === 200 && r1.json?.ok === true, JSON.stringify(r1.json))

  const r2 = await call(OUT_URL, tokenA, {
    event_type: 'note', tech_id: techId, tech_name: 'Jane Tech',
    summary: 'Site requires gate code 4471 for access; call ahead 15 minutes.',
  })
  check('agent-outcome: note w/ tech -> 200 ok', r2.status === 200 && r2.json?.ok === true, JSON.stringify(r2.json))

  const r3 = await call(OUT_URL, tokenA, {
    event_type: 'dispatch_rejected', customer_id: customerId, tech_id: techId,
    summary: 'Rejected: customer requires a certified electrician; assigned tech lacked certification.',
  })
  check('agent-outcome: dispatch_rejected w/ reason -> 200 ok', r3.status === 200 && r3.json?.ok === true, JSON.stringify(r3.json))

  const afterMemoryWorthy = await memoryCountFor(slugA)
  check('agent-outcome: 3 memory-worthy events -> 3 new tagged memory rows (allowlist fix verified live)', afterMemoryWorthy === before + 3, `before=${before} after=${afterMemoryWorthy}`)

  // contract_won w/o distinguishing content -> activity log only, no new memory row (WO §4)
  const r4 = await call(OUT_URL, tokenA, { event_type: 'contract_won', customer_id: customerId, summary: 'Signed 12-month service agreement.' })
  check('agent-outcome: contract_won -> 200 ok', r4.status === 200 && r4.json?.ok === true)
  const afterWon = await memoryCountFor(slugA)
  check('agent-outcome: contract_won -> activity log only, no new memory row', afterWon === afterMemoryWorthy, `afterMemoryWorthy=${afterMemoryWorthy} afterWon=${afterWon}`)

  // ── round trip: the outcome memories are recallable via agent-context for that customer/tech ──────
  const rctx = await call(CTX_URL, tokenA, { customer_id: customerId, tech_ids: [techId] })
  check('agent-context: 200', rctx.status === 200)
  const ctx = rctx.json?.context ?? ''
  check('agent-context: digest contains customer fact', ctx.includes('morning appointments'), ctx)
  check('agent-context: digest contains tech fact', ctx.includes('gate code 4471'), ctx)
  check('agent-context: digest contains rejection fact', ctx.includes('certified electrician'), ctx)
  check('agent-context: digest <= 2000 chars', ctx.length <= 2000, `len=${ctx.length}`)
  check('agent-context: no raw uuids in the prose', !ctx.includes(customerId) && !ctx.includes(techId))

  // ── cross-client leakage negative — THE test (WO §2/§3) ─────────────────────────────────────────
  // seed client B's own bait memory via B's OWN token, tagged to the SAME customer_id as client A,
  // to make this the maximally strict version of the test (same entity id, different client).
  const rb = await call(OUT_URL, tokenB, {
    event_type: 'note', customer_id: customerId, customer_name: 'Totally Different Co',
    summary: 'CLIENT-B-ONLY-SECRET-MARKER should never appear in client A context.',
  })
  check('agent-outcome: client B seed -> 200 ok', rb.status === 200 && rb.json?.ok === true, JSON.stringify(rb.json))

  const rctxLeak = await call(CTX_URL, tokenA, { customer_id: customerId, tech_ids: [techId] })
  const ctxLeak = rctxLeak.json?.context ?? ''
  check('LEAKAGE NEGATIVE: client A context never contains client B content', !ctxLeak.includes('CLIENT-B-ONLY-SECRET-MARKER'), ctxLeak)

  const rctxB = await call(CTX_URL, tokenB, { customer_id: customerId, tech_ids: [] })
  check('agent-context: client B sees its OWN memory', (rctxB.json?.context ?? '').includes('CLIENT-B-ONLY-SECRET-MARKER'))
  check('LEAKAGE NEGATIVE (reverse): client B context never contains client A content', !(rctxB.json?.context ?? '').includes('gate code 4471'))

  const rbSqlOnly = await call(OUT_URL, tokenB, {
    event_type: 'note', customer_id: otherCustomerId, customer_name: 'SQL Backstop Bait Co',
    summary: 'CLIENT-B-SQL-LAYER-ONLY-MARKER should never appear for client A at the RPC layer.',
  })
  check('agent-outcome: client B SQL-layer bait seed -> 200 ok', rbSqlOnly.status === 200 && rbSqlOnly.json?.ok === true, JSON.stringify(rbSqlOnly.json))

  const sqlCrossA = await admin.rpc('get_agent_client_context', { p_client_slug: slugA, p_wanted_tags: [`isb-customer:${otherCustomerId}`], p_limit: 20 })
  check('SQL BACKSTOP: client A slug + client B-only customer tag -> 0 rows', !sqlCrossA.error && (sqlCrossA.data ?? []).length === 0, sqlCrossA.error?.message ?? JSON.stringify(sqlCrossA.data))

  const sqlCrossB = await admin.rpc('get_agent_client_context', { p_client_slug: slugB, p_wanted_tags: [`isb-tech:${techId}`], p_limit: 20 })
  check('SQL BACKSTOP (reverse): client B slug + client A-only tech tag -> 0 rows', !sqlCrossB.error && (sqlCrossB.data ?? []).length === 0, sqlCrossB.error?.message ?? JSON.stringify(sqlCrossB.data))

  const anonRpc = await anonClient.rpc('get_agent_client_context', { p_client_slug: slugA, p_wanted_tags: [`isb-customer:${customerId}`], p_limit: 20 })
  check('get_agent_client_context direct execute as anon -> denied 42501', denied(anonRpc), anonRpc.error?.code ?? anonRpc.error?.message)
  const authRpc = await authenticatedRpcClient.rpc('get_agent_client_context', { p_client_slug: slugA, p_wanted_tags: [`isb-customer:${customerId}`], p_limit: 20 })
  check('get_agent_client_context direct execute as authenticated -> denied 42501', denied(authRpc), authRpc.error?.code ?? authRpc.error?.message)

  // ── rate limit trip (prove once per endpoint) — preset the bucket to empty rather than firing
  //    60-120 real requests; rate_take's own atomicity is already covered by migration 0023's design ──
  const zeroCtx = await admin.from('rate_limits').upsert(
    { actor_id: SYSTEM_ACTOR_ID, bucket: `agent_context:${slugA}`, tokens: -1000, updated_at: new Date().toISOString() },
    { onConflict: 'actor_id,bucket' },
  )
  if (zeroCtx.error) throw new Error(`preset agent_context bucket: ${zeroCtx.error.message}`)
  const rlCtx = await call(CTX_URL, tokenA, { customer_id: customerId, tech_ids: [] })
  check('agent-context: rate limit trips at 0 tokens -> 429', rlCtx.status === 429, JSON.stringify(rlCtx.json))

  const zeroOut = await admin.from('rate_limits').upsert(
    { actor_id: SYSTEM_ACTOR_ID, bucket: `agent_outcome:${slugA}`, tokens: -1000, updated_at: new Date().toISOString() },
    { onConflict: 'actor_id,bucket' },
  )
  if (zeroOut.error) throw new Error(`preset agent_outcome bucket: ${zeroOut.error.message}`)
  const rlOut = await call(OUT_URL, tokenA, { event_type: 'note', summary: 'should be rate limited' })
  check('agent-outcome: rate limit trips at 0 tokens -> 429', rlOut.status === 429, JSON.stringify(rlOut.json))

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()
  .catch((e) => { console.error('SMOKE ERROR:', e.message); process.exitCode = 1 })
  .finally(async () => { try { await cleanup() } catch (e) { console.error('cleanup failed (manual cleanup may be needed):', e.message) } })
