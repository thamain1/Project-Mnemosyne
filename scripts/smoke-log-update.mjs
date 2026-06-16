#!/usr/bin/env node
// Mnemosyne — Unit C live smoke for /api/log-update (Aegis-required battery, thread 0017).
// Creates throwaway auth users via the admin API (a real ACTIVE member + a NON-member), signs them in to
// get genuine member JWTs, runs the full positive+negative battery against the LIVE endpoint, verifies the
// row's actor_id == authenticated uid, checks no secret-note residue, then cleans everything up.
//
// Run: node --env-file=.env.local scripts/smoke-log-update.mjs
// Reads: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY.

import { createClient } from '@supabase/supabase-js'

const BASE = process.env.SMOKE_BASE || 'https://project-mnemosyne.pages.dev'
const URL = process.env.VITE_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !SERVICE || !PUB) { console.error('missing env (URL / SERVICE / PUBLISHABLE)'); process.exit(1) }

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const PW = 'Smoke!' + Math.abs(URL.length * 7919).toString(36) + 'xZ9'   // deterministic-ish, no Math.random need
const stamp = process.env.SMOKE_STAMP || String(Date.now())
const memberEmail = `smoke-member-${stamp}@mnemosyne.test`
const nonmemberEmail = `smoke-nonmember-${stamp}@mnemosyne.test`

let pass = 0, fail = 0
const results = []
function check(name, ok, extra = '') { results.push({ name, ok, extra }); ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

async function post(body, token, raw = false) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}/api/log-update`, { method: 'POST', headers, body: raw ? body : JSON.stringify(body) })
  let data = null; try { data = await res.json() } catch {}
  return { status: res.status, data, rawText: JSON.stringify(data ?? '') }
}

async function signIn(email) {
  const c = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await c.auth.signInWithPassword({ email, password: PW })
  if (error || !data?.session?.access_token) throw new Error(`sign-in failed for ${email}: ${error?.message}`)
  return data.session.access_token
}

let memberUid, nonmemberUid
async function setup() {
  const m = await admin.auth.admin.createUser({ email: memberEmail, password: PW, email_confirm: true })
  if (m.error) throw new Error('createUser member: ' + m.error.message)
  memberUid = m.data.user.id
  const ins = await admin.from('team_members').insert({ id: memberUid, full_name: 'Smoke Member', email: memberEmail, role: 'member', active: true })
  if (ins.error) throw new Error('insert team_members: ' + ins.error.message)

  const n = await admin.auth.admin.createUser({ email: nonmemberEmail, password: PW, email_confirm: true })
  if (n.error) throw new Error('createUser nonmember: ' + n.error.message)
  nonmemberUid = n.data.user.id   // intentionally NOT inserted into team_members
}

async function cleanup() {
  // delete smoke activity_log rows first (FK actor_id -> team_members has no cascade), then the users (cascade member row)
  if (memberUid) await admin.from('activity_log').delete().eq('actor_id', memberUid)
  if (memberUid) await admin.auth.admin.deleteUser(memberUid)
  if (nonmemberUid) await admin.auth.admin.deleteUser(nonmemberUid)
}

async function run() {
  await setup()
  const memberJwt = await signIn(memberEmail)
  const nonmemberJwt = await signIn(nonmemberEmail)

  // 1) valid member + non-secret note -> 201 + id
  const ok1 = await post({ note: 'Unit C smoke — working on the sales factory', action: 'work.note' }, memberJwt)
  const createdId = ok1.data?.id
  check('valid member note -> 201 + id', ok1.status === 201 && typeof createdId === 'string', `status=${ok1.status} id=${createdId}`)

  // 2) row's actor_id == authenticated member uid (not forgeable)
  if (createdId) {
    const { data: row } = await admin.from('activity_log').select('id, actor_id, action, detail').eq('id', createdId).maybeSingle()
    check('row actor_id == member uid', row?.actor_id === memberUid, `actor_id=${row?.actor_id}`)
    check('row stores note in detail', row?.detail?.note === 'Unit C smoke — working on the sales factory')
  } else { check('row actor_id == member uid', false, 'no id returned'); check('row stores note in detail', false) }

  // 3) missing JWT -> 401
  const r401a = await post({ note: 'x' }, null)
  check('missing JWT -> 401', r401a.status === 401, `status=${r401a.status}`)
  // 4) invalid JWT -> 401
  const r401b = await post({ note: 'x' }, 'not-a-real-jwt')
  check('invalid JWT -> 401', r401b.status === 401, `status=${r401b.status}`)
  // 5) non-member JWT -> 403
  const r403 = await post({ note: 'x' }, nonmemberJwt)
  check('non-member JWT -> 403', r403.status === 403, `status=${r403.status}`)
  // 6) empty note -> 400
  const e1 = await post({ note: '   ' }, memberJwt)
  check('empty note -> 400', e1.status === 400, `status=${e1.status}`)
  // 7) oversized note -> 400
  const e2 = await post({ note: 'a'.repeat(1001) }, memberJwt)
  check('oversized note -> 400', e2.status === 400, `status=${e2.status}`)
  // 8) bad action (not namespaced) -> 400
  const e3 = await post({ note: 'hi', action: 'notdotted' }, memberJwt)
  check('bad action -> 400', e3.status === 400, `status=${e3.status}`)
  // 9) invalid entity_id -> 400
  const e4 = await post({ note: 'hi', entity_id: 'not-a-uuid' }, memberJwt)
  check('invalid entity_id -> 400', e4.status === 400, `status=${e4.status}`)
  // 10) extra key -> 400
  const e5 = await post({ note: 'hi', bogus: 1 }, memberJwt)
  check('extra key -> 400', e5.status === 400, `status=${e5.status}`)
  // 11) actor forgery: actor_id in body -> 400 (additionalProperties)
  const e6 = await post({ note: 'hi', actor_id: nonmemberUid }, memberJwt)
  check('actor_id forgery field -> 400', e6.status === 400, `status=${e6.status}`)
  // 12) secret-bearing note -> rejected (DB scan), and leaves NO row
  const sec = await post({ note: 'my aws key is AKIAIOSFODNN7EXAMPLE please store', action: 'work.note' }, memberJwt)
  check('secret-bearing note -> 4xx (rejected)', sec.status >= 400 && sec.status < 500, `status=${sec.status}`)

  // 13) no residue: member should have exactly ONE row (the valid 201); secret + 400s wrote nothing
  const { count } = await admin.from('activity_log').select('id', { count: 'exact', head: true }).eq('actor_id', memberUid)
  check('no extra-row residue (exactly 1 row)', count === 1, `count=${count}`)

  // 14) responses carry no secret/service-role markers
  const blob = [ok1.rawText, r403.rawText, sec.rawText].join(' ')
  check('responses have no service-role/secret markers', !/service_role|sb_secret_|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\./.test(blob))
}

run().catch((e) => { console.error('SMOKE ERROR:', e.message); fail++ })
  .finally(async () => {
    try { await cleanup() } catch (e) { console.error('cleanup warning:', e.message) }
    console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} pass / ${fail} fail`)
    process.exit(fail === 0 ? 0 : 1)
  })
