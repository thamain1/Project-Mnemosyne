#!/usr/bin/env node
// Mnemosyne — P5-TELEMETRY live smoke (thread 0025, migration 0024). Asserts the acceptance gate:
//   1. anon/authenticated direct INSERT into usage_events fails 42501; member SELECT succeeds;
//      log_usage is executable only as service_role (write-gates-are-policy-not-convention standard).
//   2. A live /api/recall call produces exactly one usage row (embed-only call — Gemini's
//      embedContent endpoint does not expose token usage, so tokens are honestly null; bytes are
//      populated as the documented proxy metric — see thread 0025 "honest scope").
//   3. A live /api/generate-contract call (which DOES call generateContent) produces a row with
//      real provider input/output token counts populated.
//   4. A live /api/render-document call produces a row with bytes_out ≈ the returned PDF size.
//   5. Telemetry is best-effort: logUsage/logMcpUsage wrap the RPC in try/catch with no rethrow —
//      verified by code inspection (functions/_lib/usage.ts, mcp/lib/usage-core.mjs), not a live
//      fault-injection (mirrors how 0023's rate-limit try/catch was verified).
//
// Run: node --env-file=.env.local scripts/smoke-usage-telemetry.mjs

import { createClient } from '@supabase/supabase-js'
import { cleanupMember } from './lib/cleanup-member.mjs'

const BASE = process.env.SMOKE_BASE || 'https://project-mnemosyne.pages.dev'
const URL = process.env.VITE_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !SERVICE || !PUB) { console.error('missing env (URL / SERVICE / PUBLISHABLE)'); process.exit(1) }

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const anonClient = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } })
const PW = 'Smoke!' + Math.abs(URL.length * 7919).toString(36) + 'xZ9'
const stamp = process.env.SMOKE_STAMP || String(Date.now())
const memberEmail = `smoke-usage-member-${stamp}@mnemosyne.test`

let pass = 0, fail = 0
function check(name, ok, extra = '') { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

async function post(path, body, token) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/pdf')) return { status: res.status, ct, bytes: Buffer.from(await res.arrayBuffer()) }
  let json = null; try { json = await res.json() } catch {}
  return { status: res.status, ct, json }
}
async function signIn(email) {
  const { data, error } = await anonClient.auth.signInWithPassword({ email, password: PW })
  if (error || !data?.session?.access_token) throw new Error(`sign-in failed for ${email}: ${error?.message}`)
  return data.session.access_token
}

let memberUid
async function setup() {
  const m = await admin.auth.admin.createUser({ email: memberEmail, password: PW, email_confirm: true })
  if (m.error) throw new Error('createUser member: ' + m.error.message)
  memberUid = m.data.user.id
  const ins = await admin.from('team_members').insert({ id: memberUid, full_name: 'Smoke Usage Member', email: memberEmail, role: 'member', active: true })
  if (ins.error) throw new Error('insert team_members: ' + ins.error.message)
}
async function cleanup() {
  // FK-drop-safe (thread 0029): deletes actor-keyed rows, tries a real delete, falls back to deactivate.
  await cleanupMember(admin, memberUid)
}

async function main() {
  await setup()
  try {
    const memberJwt = await signIn(memberEmail)

    // ---- 1a. anon direct INSERT -> 42501 ----
    const anonIns = await anonClient.from('usage_events').insert({ source: 'endpoint', tool: 'x' })
    check('anon direct INSERT -> 42501', anonIns.error?.code === '42501', `code=${anonIns.error?.code}`)

    // ---- 1b. authenticated (member) direct INSERT -> 42501 (writes gated to service_role, not just policy) ----
    const memberClient = createClient(URL, PUB, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { authorization: `Bearer ${memberJwt}` } },
    })
    const memberIns = await memberClient.from('usage_events').insert({ source: 'endpoint', tool: 'x' })
    check('authenticated direct INSERT -> 42501', memberIns.error?.code === '42501', `code=${memberIns.error?.code}`)

    // ---- 1c. log_usage callable only as service_role ----
    const memberRpc = await memberClient.rpc('log_usage', { p_actor: memberUid, p_source: 'endpoint', p_tool: 'x' })
    check('log_usage via authenticated role -> error (no execute grant)', !!memberRpc.error, `error=${memberRpc.error?.message}`)
    const svcRpc = await admin.rpc('log_usage', { p_actor: memberUid, p_source: 'script', p_tool: 'smoke-direct-check' })
    check('log_usage via service_role -> succeeds', !svcRpc.error && !!svcRpc.data, `error=${svcRpc.error?.message}`)

    // ---- 1d. member SELECT succeeds (RLS allows team-member read) ----
    const memberSel = await memberClient.from('usage_events').select('id').limit(1)
    check('member SELECT on usage_events -> succeeds', !memberSel.error, `error=${memberSel.error?.message}`)

    // ---- 2. /api/recall produces exactly one usage row ----
    const beforeRecall = Date.now()
    const rc = await post('/api/recall', { query: 'usage telemetry smoke test query', k: 1 }, memberJwt)
    check('recall call -> 200', rc.status === 200, `status=${rc.status}`)
    await new Promise((r) => setTimeout(r, 1500)) // best-effort write is fire-and-forget-ish; give it a beat
    const { data: recallRows } = await admin.from('usage_events').select('*').eq('actor_id', memberUid).eq('tool', 'api/recall').gte('created_at', new Date(beforeRecall).toISOString())
    check('recall -> exactly one usage_events row', (recallRows ?? []).length === 1, `rows=${recallRows?.length}`)
    check('recall row has bytes populated (proxy metric)', (recallRows?.[0]?.bytes_in ?? 0) > 0 && (recallRows?.[0]?.bytes_out ?? 0) >= 0)

    // ---- 3. /api/generate-contract produces a row with real provider token counts ----
    // (Was a KNOWN FAIL 2026-07-02 while the endpoint was reverted during the CF-1101 incident;
    // resolved same day — missing logUsage import, thread 0026, fix 7907c9b. All 3 checks pass.)
    const beforeGen = Date.now()
    const gc = await post('/api/generate-contract', {
      doc_type: 'mou',
      fields: {
        project_name: 'Usage Telemetry Smoke Portal',
        client_entity: 'Acme Wellness LLC, a North Carolina limited liability company',
        client_attn: 'Dana Rivera',
        client_signatory_name: 'Dana Rivera',
        engagement_ref: 'SMOKE-USAGE-001',
        sow_ref: 'SMOKE-USAGE-SOW-001',
        timeline: 'eight (8) weeks',
        milestones_table: '| # | Milestone | Trigger | Amount |\n|---|---|---|---|\n| 1 | Kickoff | Signature | $1,000 |\n\n**Total: $1,000**',
        fee_summary: 'A flat project fee of $1,000, due at kickoff.',
        purpose: 'A short member portal for booking and attendance tracking.',
        scope_summary: 'Signup, booking, and attendance tracking.',
        client_responsibilities: 'Provide branding assets and content in a timely manner.',
      },
      ground: false,
    }, memberJwt)
    check('generate-contract call -> 200', gc.status === 200, `status=${gc.status} ${gc.json ? JSON.stringify(gc.json).slice(0, 150) : ''}`)
    await new Promise((r) => setTimeout(r, 1500))
    const { data: genRows } = await admin.from('usage_events').select('*').eq('actor_id', memberUid).eq('tool', 'api/generate-contract').gte('created_at', new Date(beforeGen).toISOString())
    check('generate-contract -> one usage_events row', (genRows ?? []).length === 1, `rows=${genRows?.length}`)
    check('generate-contract row has real provider tokens', (genRows?.[0]?.input_tokens ?? 0) > 0 && (genRows?.[0]?.output_tokens ?? 0) > 0, JSON.stringify(genRows?.[0]))

    // ---- 4. /api/render-document produces a row with bytes_out ≈ PDF size ----
    const beforeRender = Date.now()
    const rd = await post('/api/render-document', { doc_type: 'mou', markdown: '{{block:logo}}\n\n# MOU\n\nA short clean body for the smoke test.' }, memberJwt)
    if (rd.status === 503) {
      check('render-document -> 200 PDF', false, '503: CF_ACCOUNT_ID/CF_BROWSER_RENDERING_TOKEN not bound (skip bytes_out check)')
    } else {
      check('render-document call -> 200 PDF', rd.status === 200 && rd.ct.includes('application/pdf'), `status=${rd.status}`)
      await new Promise((r) => setTimeout(r, 1500))
      const { data: renderRows } = await admin.from('usage_events').select('*').eq('actor_id', memberUid).eq('tool', 'api/render-document').gte('created_at', new Date(beforeRender).toISOString())
      check('render-document -> one usage_events row', (renderRows ?? []).length === 1, `rows=${renderRows?.length}`)
      const bytesOut = renderRows?.[0]?.bytes_out ?? 0
      check('render-document row bytes_out ≈ PDF size', rd.bytes && Math.abs(bytesOut - rd.bytes.length) < 100, `bytes_out=${bytesOut} pdf=${rd.bytes?.length}`)
    }
  } finally {
    await cleanup()
  }
  console.log(`\n[smoke-usage-telemetry] pass=${pass} fail=${fail}`)
  if (fail) process.exitCode = 1
}
main().catch((e) => { console.error('SMOKE ERROR:', e.message); cleanup().finally(() => process.exit(1)) })
