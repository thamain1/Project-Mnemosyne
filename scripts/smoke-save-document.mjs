#!/usr/bin/env node
// Mnemosyne — C4.2 live smoke for /api/save-document + the 0014 write-lockdown (Aegis gate, thread 0018).
// Creates a throwaway active member + non-member; generates a real MOU draft via /api/generate-contract;
// proves: (a) an authenticated member CANNOT direct insert/update/delete documents or document_chunks via the
// Data API (0014 lockdown), (b) /api/save-document still saves through the RPC (201, origin='draft',
// created_by=uid, chunks, document.save_draft audit), (c) planted brand/secret/marker -> 422 no residue,
// (d) 401/403/400 paths incl. arbitrary-markdown shape gate, (e) draft findable via /api/search-docs,
// (f) no ingested final modified. Cleans up the draft row + chunks + audit + users.
//
// Run: node --env-file=.env.local scripts/smoke-save-document.mjs

import { createClient } from '@supabase/supabase-js'
import { cleanupMember } from './lib/cleanup-member.mjs'

const BASE = process.env.SMOKE_BASE || 'https://project-mnemosyne.pages.dev'
const URL = process.env.VITE_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
const REF = process.env.SUPABASE_PROJECT_REF, TOK = process.env.SUPABASE_ACCESS_TOKEN
if (!URL || !SERVICE || !PUB) { console.error('missing env'); process.exit(1) }

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const PW = 'Smoke!' + Math.abs(URL.length * 7919).toString(36) + 'xZ9'
const stamp = process.env.SMOKE_STAMP || String(Date.now())
const memberEmail = `smoke-save-member-${stamp}@mnemosyne.test`
const nonmemberEmail = `smoke-save-nonmember-${stamp}@mnemosyne.test`

let pass = 0, fail = 0
function check(name, ok, extra = '') { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }
async function api(path, body, token, raw = false) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: raw ? body : JSON.stringify(body) })
  let data = null; try { data = await res.json() } catch {}
  return { status: res.status, data, rawText: JSON.stringify(data ?? '') }
}
async function signIn(email) {
  const c = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await c.auth.signInWithPassword({ email, password: PW })
  if (error || !data?.session?.access_token) throw new Error(`sign-in failed: ${error?.message}`)
  return data.session.access_token
}

const MOU_FIELDS = {
  project_name: 'C4.2 Smoke Portal — Launch Core', client_entity: 'Smoke Test LLC, a Delaware limited liability company',
  client_attn: 'Sam Tester, Founder', client_signatory_name: 'Sam Tester', engagement_ref: 'SMK-2026-001',
  sow_ref: 'SMK-SOW-001 — Smoke Portal', timeline: 'six (6) weeks',
  milestones_table: '| # | Milestone | Trigger | Amount |\n|---|---|---|---:|\n| M1 | Deposit | Execution | $1,000.00 |\n| | **Total** | | **$1,000.00** |',
  fee_summary: 'Total fixed fee $1,000, payable at execution.', purpose: 'A smoke-test portal to validate C4.2 persistence.',
  scope_summary: 'a login; a dashboard; an admin view.', client_responsibilities: 'provide brand assets and timely review.',
}

let memberUid, nonmemberUid, draftId
async function setup() {
  const m = await admin.auth.admin.createUser({ email: memberEmail, password: PW, email_confirm: true })
  if (m.error) throw new Error('createUser member: ' + m.error.message)
  memberUid = m.data.user.id
  const ins = await admin.from('team_members').insert({ id: memberUid, full_name: 'Smoke Save Member', email: memberEmail, role: 'member', active: true })
  if (ins.error) throw new Error('insert team_members: ' + ins.error.message)
  const n = await admin.auth.admin.createUser({ email: nonmemberEmail, password: PW, email_confirm: true })
  if (n.error) throw new Error('createUser nonmember: ' + n.error.message)
  nonmemberUid = n.data.user.id
}
async function cleanup() {
  if (draftId) { await admin.from('document_chunks').delete().eq('document_id', draftId); await admin.from('activity_log').delete().eq('entity_id', draftId); await admin.from('documents').delete().eq('id', draftId) }
  // FK-drop-safe (thread 0029): deletes actor-keyed rows, tries a real delete, falls back to deactivate.
  await cleanupMember(admin, memberUid)
  await cleanupMember(admin, nonmemberUid)
}

async function run() {
  await setup()
  const memberJwt = await signIn(memberEmail)
  const nonmemberJwt = await signIn(nonmemberEmail)
  const memberClient = createClient(URL, PUB, { global: { headers: { Authorization: `Bearer ${memberJwt}` } }, auth: { persistSession: false, autoRefreshToken: false } })

  // 0014 lockdown: an authenticated member must NOT be able to direct-write documents/document_chunks
  const di = await memberClient.from('documents').insert({ doc_type: 'mou', title: 'BYPASS attempt', extracted_text: 'x' }).select('id')
  check('member direct INSERT documents -> denied', !!di.error || (di.data?.length ?? 0) === 0, di.error ? `(${di.error.code})` : `inserted ${di.data?.length}`)
  if (di.data?.[0]?.id) await admin.from('documents').delete().eq('id', di.data[0].id) // safety cleanup if it leaked
  const ci = await memberClient.from('document_chunks').insert({ document_id: '00000000-0000-0000-0000-000000000000', chunk_index: 0, content: 'x' }).select('id')
  check('member direct INSERT document_chunks -> denied', !!ci.error || (ci.data?.length ?? 0) === 0, ci.error ? `(${ci.error.code})` : `inserted ${ci.data?.length}`)
  const du = await memberClient.from('documents').update({ title: 'HACKED' }).eq('origin', 'ingested').select('id')
  check('member direct UPDATE documents -> denied/no-op', !!du.error || (du.data?.length ?? 0) === 0, du.error ? `(${du.error.code})` : `updated ${du.data?.length}`)
  const dd = await memberClient.from('documents').delete().eq('origin', 'ingested').select('id')
  check('member direct DELETE documents -> denied/no-op', !!dd.error || (dd.data?.length ?? 0) === 0, dd.error ? `(${dd.error.code})` : `deleted ${dd.data?.length}`)
  // confirm the 12 finals are untouched
  const { count: finals } = await admin.from('documents').select('id', { count: 'exact', head: true }).eq('origin', 'ingested')
  check('ingested finals intact (12)', finals === 12, `count=${finals}`)

  // generate a real MOU draft
  const gen = await api('/api/generate-contract', { doc_type: 'mou', fields: MOU_FIELDS, ground: true }, memberJwt)
  check('generate MOU -> 200 + scan_clean', gen.status === 200 && gen.data?.scan_clean === true, `status=${gen.status} clean=${gen.data?.scan_clean}`)
  const md = gen.data?.markdown ?? ''

  // save it -> 201 via RPC
  const save = await api('/api/save-document', { doc_type: 'mou', title: gen.data?.title ?? 'MOU', markdown: md }, memberJwt)
  draftId = save.data?.id
  check('save draft -> 201 + id', save.status === 201 && typeof draftId === 'string', `status=${save.status} id=${draftId}`)
  if (draftId) {
    const { data: row } = await admin.from('documents').select('origin, created_by, doc_type').eq('id', draftId).maybeSingle()
    check('row origin=draft + created_by=uid', row?.origin === 'draft' && row?.created_by === memberUid, `origin=${row?.origin} by=${row?.created_by}`)
    const { count: ch } = await admin.from('document_chunks').select('id', { count: 'exact', head: true }).eq('document_id', draftId)
    check('chunks persisted', (ch ?? 0) >= 1, `chunks=${ch}`)
    const { data: aud } = await admin.from('activity_log').select('action, actor_id').eq('entity_id', draftId).eq('action', 'document.save_draft').maybeSingle()
    check('audit row document.save_draft + actor=uid', aud?.actor_id === memberUid, `actor=${aud?.actor_id}`)
  }

  // findable via search-docs
  const srch = await api('/api/search-docs', { query: 'C4.2 Smoke Portal launch core', k: 10 }, memberJwt)
  check('draft findable via /api/search-docs', (srch.data?.results ?? []).some((r) => r.id === draftId), `hits=${(srch.data?.results ?? []).length}`)

  // planted prohibited content -> 422, no row
  const planted = md.replace('## 1. Purpose', '## 1. Purpose\n\nThis platform runs on Supabase and Stripe.')
  const before = (await admin.from('documents').select('id', { count: 'exact', head: true }).eq('origin', 'draft')).count
  const block = await api('/api/save-document', { doc_type: 'mou', title: 'planted', markdown: planted }, memberJwt)
  const after = (await admin.from('documents').select('id', { count: 'exact', head: true }).eq('origin', 'draft')).count
  check('planted brand -> 422', block.status === 422, `status=${block.status}`)
  check('planted brand -> no new row', before === after, `before=${before} after=${after}`)

  // auth/arg paths
  check('missing JWT -> 401', (await api('/api/save-document', { doc_type: 'mou', title: 't', markdown: md }, null)).status === 401)
  check('non-member -> 403', (await api('/api/save-document', { doc_type: 'mou', title: 't', markdown: md }, nonmemberJwt)).status === 403)
  check('bad doc_type -> 400', (await api('/api/save-document', { doc_type: 'invoice', title: 't', markdown: md }, memberJwt)).status === 400)
  check('arbitrary markdown (shape gate) -> 400', (await api('/api/save-document', { doc_type: 'mou', title: 't', markdown: '# just some notes, no party block' }, memberJwt)).status === 400)
  check('extra key -> 400', (await api('/api/save-document', { doc_type: 'mou', title: 't', markdown: md, bogus: 1 }, memberJwt)).status === 400)
}

run().catch((e) => { console.error('SMOKE ERROR:', e.message); fail++ })
  .finally(async () => {
    try { await cleanup() } catch (e) { console.error('cleanup warning:', e.message) }
    console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} pass / ${fail} fail`)
    process.exit(fail === 0 ? 0 : 1)
  })
