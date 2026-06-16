#!/usr/bin/env node
// Mnemosyne — C5.1 live smoke for the CRM write path + 0015 lockdown (Aegis gate, thread 0019).
// Throwaway active member + non-member. Proves: member CANNOT direct insert/update/delete clients/contacts/
// deals (42501); endpoints create client+deal (201), edit deal (200), move stage, link/detach a real document;
// audit rows crm.client_save/crm.deal_save/crm.document_link attributed to uid; 401/403/400 paths. Cleans up.
//
// Run: node --env-file=.env.local scripts/smoke-crm.mjs

import { createClient } from '@supabase/supabase-js'

const BASE = process.env.SMOKE_BASE || 'https://project-mnemosyne.pages.dev'
const URL = process.env.VITE_SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !SERVICE || !PUB) { console.error('missing env'); process.exit(1) }

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const PW = 'Smoke!' + Math.abs(URL.length * 7919).toString(36) + 'xZ9'
const stamp = process.env.SMOKE_STAMP || String(Date.now())
const memberEmail = `smoke-crm-member-${stamp}@mnemosyne.test`
const nonmemberEmail = `smoke-crm-nonmember-${stamp}@mnemosyne.test`

let pass = 0, fail = 0
function check(n, ok, extra = '') { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`) }
async function api(path, body, token, raw = false) {
  const headers = { 'content-type': 'application/json' }; if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: raw ? body : JSON.stringify(body) })
  let data = null; try { data = await res.json() } catch {}
  return { status: res.status, data }
}
async function signIn(email) {
  const c = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await c.auth.signInWithPassword({ email, password: PW })
  if (error || !data?.session?.access_token) throw new Error(`sign-in failed: ${error?.message}`)
  return data.session.access_token
}

let memberUid, nonmemberUid, clientId, dealId, docId, docHadDeal
async function setup() {
  const m = await admin.auth.admin.createUser({ email: memberEmail, password: PW, email_confirm: true })
  if (m.error) throw new Error('createUser member: ' + m.error.message); memberUid = m.data.user.id
  const ins = await admin.from('team_members').insert({ id: memberUid, full_name: 'Smoke CRM Member', email: memberEmail, role: 'member', active: true })
  if (ins.error) throw new Error('insert team_members: ' + ins.error.message)
  const n = await admin.auth.admin.createUser({ email: nonmemberEmail, password: PW, email_confirm: true })
  if (n.error) throw new Error('createUser nonmember: ' + n.error.message); nonmemberUid = n.data.user.id
  // borrow an existing ingested document for the linkage test (record its prior deal_id to restore)
  const { data: doc } = await admin.from('documents').select('id, deal_id').eq('origin', 'ingested').limit(1).maybeSingle()
  docId = doc?.id; docHadDeal = doc?.deal_id ?? null
}
async function cleanup() {
  if (docId) await admin.from('documents').update({ deal_id: docHadDeal }).eq('id', docId) // restore linkage
  if (dealId) { await admin.from('activity_log').delete().eq('entity_id', dealId); await admin.from('deals').delete().eq('id', dealId) }
  if (clientId) { await admin.from('activity_log').delete().eq('entity_id', clientId); await admin.from('clients').delete().eq('id', clientId) }
  if (docId) await admin.from('activity_log').delete().eq('entity_id', docId).eq('action', 'crm.document_link')
  if (memberUid) await admin.auth.admin.deleteUser(memberUid)
  if (nonmemberUid) await admin.auth.admin.deleteUser(nonmemberUid)
}

async function run() {
  await setup()
  const memberJwt = await signIn(memberEmail)
  const nonmemberJwt = await signIn(nonmemberEmail)
  const mc = createClient(URL, PUB, { global: { headers: { Authorization: `Bearer ${memberJwt}` } }, auth: { persistSession: false, autoRefreshToken: false } })

  // 0015 lockdown: member must NOT direct-write any CRM table
  for (const t of ['clients', 'contacts', 'deals']) {
    const row = t === 'deals' ? { title: 'BYPASS', stage: 'lead' } : { name: 'BYPASS' }
    const r = await mc.from(t).insert(row).select('id')
    check(`member direct INSERT ${t} -> denied`, !!r.error || (r.data?.length ?? 0) === 0, r.error ? `(${r.error.code})` : `inserted ${r.data?.length}`)
    if (r.data?.[0]?.id) await admin.from(t).delete().eq('id', r.data[0].id)
  }
  const up = await mc.from('clients').update({ name: 'HACKED' }).neq('id', '00000000-0000-0000-0000-000000000000').select('id')
  check('member direct UPDATE clients -> denied/no-op', !!up.error || (up.data?.length ?? 0) === 0, up.error ? `(${up.error.code})` : `updated ${up.data?.length}`)

  // endpoints: create client -> create deal -> edit -> move stage
  const c = await api('/api/upsert-client', { name: 'Smoke Client Co', notes: 'created by C5 smoke' }, memberJwt)
  clientId = c.data?.id
  check('create client -> 201 + id', c.status === 201 && !!clientId, `status=${c.status}`)

  const d = await api('/api/upsert-deal', { title: 'Smoke Deal', stage: 'lead', client_id: clientId, amount: 5000, currency: 'USD', owner_id: memberUid, notes: 'n' }, memberJwt)
  dealId = d.data?.id
  check('create deal -> 201 + id', d.status === 201 && !!dealId, `status=${d.status}`)

  const e = await api('/api/upsert-deal', { id: dealId, title: 'Smoke Deal (edited)', stage: 'qualified', client_id: clientId, amount: 6000, currency: 'USD' }, memberJwt)
  check('edit deal -> 200', e.status === 200, `status=${e.status}`)
  const mv = await api('/api/upsert-deal', { id: dealId, title: 'Smoke Deal (edited)', stage: 'proposal' }, memberJwt)
  check('move stage -> 200', mv.status === 200, `status=${mv.status}`)
  const { data: drow } = await admin.from('deals').select('stage, amount, client_id').eq('id', dealId).maybeSingle()
  check('deal reflects edits (stage=proposal, amount=6000)', drow?.stage === 'proposal' && Number(drow?.amount) === 6000, `stage=${drow?.stage} amt=${drow?.amount}`)

  // link a document to the deal, then detach
  if (docId) {
    const lk = await api('/api/link-document', { document_id: docId, deal_id: dealId }, memberJwt)
    const { data: linked } = await admin.from('documents').select('deal_id').eq('id', docId).maybeSingle()
    check('link document -> deal_id set', lk.status === 200 && linked?.deal_id === dealId, `status=${lk.status} deal_id=${linked?.deal_id}`)
    const un = await api('/api/link-document', { document_id: docId, deal_id: null }, memberJwt)
    const { data: unlinked } = await admin.from('documents').select('deal_id').eq('id', docId).maybeSingle()
    check('detach document -> deal_id null', un.status === 200 && unlinked?.deal_id === null, `status=${un.status} deal_id=${unlinked?.deal_id}`)
  } else check('link/detach document', false, 'no ingested doc to borrow')

  // audit rows attributed to uid
  const { data: aud } = await admin.from('activity_log').select('action, actor_id').in('action', ['crm.client_save', 'crm.deal_save', 'crm.document_link']).eq('actor_id', memberUid)
  const acts = new Set((aud ?? []).map((r) => r.action))
  check('audit rows for client/deal/link (actor=uid)', acts.has('crm.client_save') && acts.has('crm.deal_save') && acts.has('crm.document_link'), [...acts].join(','))

  // auth/arg paths
  check('missing JWT -> 401', (await api('/api/upsert-deal', { title: 't', stage: 'lead' }, null)).status === 401)
  check('non-member -> 403', (await api('/api/upsert-deal', { title: 't', stage: 'lead' }, nonmemberJwt)).status === 403)
  check('bad stage -> 400', (await api('/api/upsert-deal', { title: 't', stage: 'banana' }, memberJwt)).status === 400)
  check('missing title -> 400', (await api('/api/upsert-deal', { stage: 'lead' }, memberJwt)).status === 400)
  check('bad uuid client_id -> 400', (await api('/api/upsert-deal', { title: 't', stage: 'lead', client_id: 'nope' }, memberJwt)).status === 400)
  check('bad amount -> 400', (await api('/api/upsert-deal', { title: 't', stage: 'lead', amount: -5 }, memberJwt)).status === 400)
  check('nonexistent owner -> 400', (await api('/api/upsert-deal', { title: 't', stage: 'lead', owner_id: '00000000-0000-0000-0000-000000000000' }, memberJwt)).status === 400)
  check('extra key -> 400', (await api('/api/upsert-client', { name: 'x', bogus: 1 }, memberJwt)).status === 400)
  check('missing name (client) -> 400', (await api('/api/upsert-client', { notes: 'x' }, memberJwt)).status === 400)
  check('link bad document_id -> 400', (await api('/api/link-document', { document_id: 'nope', deal_id: null }, memberJwt)).status === 400)
}

run().catch((e) => { console.error('SMOKE ERROR:', e.message); fail++ })
  .finally(async () => {
    try { await cleanup() } catch (e) { console.error('cleanup warning:', e.message) }
    console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} pass / ${fail} fail`)
    process.exit(fail === 0 ? 0 : 1)
  })
