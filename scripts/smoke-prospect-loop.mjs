#!/usr/bin/env node
// Mnemosyne — thread 0033 (P2-LOOP v1 + case-study/client-brief doc types) live acceptance battery.
//
// PRECONDITIONS before running against prod:
//   1. Migration 0030 applied (Aegis post-build QC + Jesse apply-go).
//   2. Code deployed (git push main; CF Pages auto-builds) — required for the render-document /
//      save-rendered-document structural-audience checks (§3) and (via smoke-hosted-mcp.mjs's
//      additions, NOT this file) the hosted client_brief/client_360 tools. The direct-RPC checks
//      (§1, §2) work against an applied-but-undeployed migration too, per the 0024 standing deploy
//      order (apply -> prove old code -> push).
//
// NOT covered here (deferred to smoke-hosted-mcp.mjs's thread-0033 additions or inherently manual):
//   - client_brief/client_360 CLIENT/DEAL RESOLUTION (uuid-or-name, ambiguous/unknown/foreign-deal) —
//     that logic lives in functions/_lib/client-brief.ts, reachable ONLY through the hosted MCP
//     endpoint (TypeScript, not a plain RPC this script can call directly). Covered live via the
//     hosted client_brief/client_360 tools in smoke-hosted-mcp.mjs's thread-0033 additions.
//   - client_360's structural truncation-drop behavior under REAL agent-produced volume — this script
//     seeds synthetic rows to force it (§4), which proves the mechanism but isn't a realistic fixture.
//   - Runbook dry-run (acceptance criterion 6): "a real agent session executes the runbook against a
//     fixture client" is inherently an agentic exercise, not a scriptable assertion — run manually
//     post-apply per the design's own framing ("analogous to 0027's criterion 10").
//   - UI: Create tab's audience-selector hiding for client-brief — visual, needs a browser.
//
// Run: node --env-file=.env.local scripts/smoke-prospect-loop.mjs

import { createClient } from '@supabase/supabase-js'
import { cleanupMember } from './lib/cleanup-member.mjs'

const BASE = process.env.SMOKE_BASE || 'https://project-mnemosyne.pages.dev'
const URL = process.env.VITE_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !SERVICE || !PUB) { console.error('missing env (URL / SERVICE / PUBLISHABLE)'); process.exit(1) }

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const PW = 'Smoke!' + Math.abs(URL.length * 6151).toString(36) + 'qL3'
const stamp = process.env.SMOKE_STAMP || String(Date.now())
const memberEmail = `smoke-0033-member-${stamp}@mnemosyne.test`

let pass = 0, fail = 0
function check(name, ok, extra = '') { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

async function api(path, body, token, method = 'POST') {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body) })
  let data = null; try { data = await res.json() } catch {}
  return { status: res.status, data }
}
async function signIn(email) {
  const c = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await c.auth.signInWithPassword({ email, password: PW })
  if (error || !data?.session?.access_token) throw new Error(`sign-in failed for ${email}: ${error?.message}`)
  return data.session.access_token
}

function randomUnitVector(dims) {
  const v = Array.from({ length: dims }, () => Math.random() - 0.5)
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map((x) => x / norm)
}
const vecLit = (v) => `[${v.join(',')}]`
const newId = () => crypto.randomUUID()

let memberUid
let clientAId, clientBId, dealAId, dealBId
let concurrentClientId
const memNamesToClean = []

async function setup() {
  const m = await admin.auth.admin.createUser({ email: memberEmail, password: PW, email_confirm: true })
  if (m.error) throw new Error('createUser member: ' + m.error.message)
  memberUid = m.data.user.id
  const ins = await admin.from('team_members').insert({ id: memberUid, full_name: 'Smoke 0033 Member', email: memberEmail, role: 'member', active: true })
  if (ins.error) throw new Error('insert team_members: ' + ins.error.message)
}

async function cleanup() {
  try {
    for (const name of memNamesToClean) {
      const { data: row } = await admin.from('memory_entries').select('id').eq('name', name).maybeSingle()
      if (row?.id) {
        await admin.from('memory_chunks').delete().eq('memory_entry_id', row.id)
        await admin.from('memory_versions').delete().eq('entry_id', row.id)
        await admin.from('activity_log').delete().eq('entity_id', row.id)
        await admin.from('memory_entries').delete().eq('id', row.id)
      }
    }
    if (dealAId) { await admin.from('activity_log').delete().eq('entity_id', dealAId); await admin.from('deals').delete().eq('id', dealAId) }
    if (dealBId) { await admin.from('activity_log').delete().eq('entity_id', dealBId); await admin.from('deals').delete().eq('id', dealBId) }
    if (clientAId) { await admin.from('activity_log').delete().eq('entity_id', clientAId); await admin.from('documents').delete().eq('client_id', clientAId); await admin.from('clients').delete().eq('id', clientAId) }
    if (clientBId) { await admin.from('activity_log').delete().eq('entity_id', clientBId); await admin.from('clients').delete().eq('id', clientBId) }
    if (concurrentClientId) { await admin.from('activity_log').delete().eq('entity_id', concurrentClientId); await admin.from('clients').delete().eq('id', concurrentClientId) }
    await cleanupMember(admin, memberUid)
  } catch (e) { console.error('cleanup warning:', e.message) }
}

async function main() {
  await setup()
  const memberJwt = await signIn(memberEmail)
  const anonClient = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } })
  const memberClient = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { authorization: `Bearer ${memberJwt}` } } })

  // ================= 1. MIGRATION POST-APPLY GATE =================
  {
    // upsert_client_brief exists + service-role-only (a 42883 "does not exist" here means the
    // migration hasn't been applied yet — everything below this point is expected to fail until it is).
    const anonRpc = await anonClient.rpc('upsert_client_brief', { p_actor: null, p_client_id: null, p_deal_id: null, p_title: 'x', p_body: 'x', p_embedding: vecLit(randomUnitVector(768)), p_embedding_model: 'gemini-embedding-001' })
    check('upsert_client_brief direct execute as anon -> denied (not "does not exist")', !!anonRpc.error && !/does not exist|schema cache/i.test(anonRpc.error.message ?? ''), anonRpc.error?.message)
    const memberRpc = await memberClient.rpc('upsert_client_brief', { p_actor: null, p_client_id: null, p_deal_id: null, p_title: 'x', p_body: 'x', p_embedding: vecLit(randomUnitVector(768)), p_embedding_model: 'gemini-embedding-001' })
    check('upsert_client_brief direct execute as authenticated -> denied', !!memberRpc.error)

    // save_rendered_document accepts the two new doc types (direct RPC, no Storage upload needed —
    // the RPC only checks the storage_path SHAPE, never that the object actually exists).
    const idCase = newId()
    const caseRes = await admin.rpc('save_rendered_document', {
      p_payload: { id: idCase, doc_type: 'case-study', title: 'Smoke Case Study', storage_path: `rendered/${idCase}/v1.pdf`, markdown: '# x', audience: 'client' },
      p_actor: memberUid, p_audit: {},
    })
    check('save_rendered_document accepts doc_type="case-study"', !caseRes.error, caseRes.error?.message)
    const idBrief = newId()
    const briefRes = await admin.rpc('save_rendered_document', {
      p_payload: { id: idBrief, doc_type: 'client-brief', title: 'Smoke Client Brief', storage_path: `rendered/${idBrief}/v1.pdf`, markdown: '# x', audience: 'internal' },
      p_actor: memberUid, p_audit: {},
    })
    check('save_rendered_document accepts doc_type="client-brief"', !briefRes.error, briefRes.error?.message)
    const idBad = newId()
    const badRes = await admin.rpc('save_rendered_document', {
      p_payload: { id: idBad, doc_type: 'not-a-real-type', title: 'x', storage_path: `rendered/${idBad}/v1.pdf`, markdown: '# x' },
      p_actor: memberUid, p_audit: {},
    })
    check('save_rendered_document still rejects an unknown doc_type', !!badRes.error && /bad doc_type/i.test(badRes.error.message ?? ''), badRes.error?.message)
    // cleanup the two documents this section created directly
    for (const id of [idCase, idBrief]) {
      await admin.from('document_versions').delete().eq('document_id', id)
      await admin.from('documents').delete().eq('id', id)
    }
  }

  // ================= 2. upsert_client_brief RPC contract =================
  {
    const cA = await admin.rpc('upsert_client', { p_payload: { name: `Smoke 0033 Client A ${stamp}` }, p_actor: memberUid, p_audit: {} })
    check('fixture client A created', !cA.error, cA.error?.message)
    clientAId = cA.data
    const cB = await admin.rpc('upsert_client', { p_payload: { name: `Smoke 0033 Client B ${stamp}` }, p_actor: memberUid, p_audit: {} })
    check('fixture client B created', !cB.error, cB.error?.message)
    clientBId = cB.data
    const dA = await admin.rpc('upsert_deal', { p_payload: { client_id: clientAId, title: `Smoke Deal A ${stamp}`, stage: 'lead' }, p_actor: memberUid, p_audit: {} })
    dealAId = dA.data
    const dB = await admin.rpc('upsert_deal', { p_payload: { client_id: clientBId, title: `Smoke Deal B ${stamp}`, stage: 'lead' }, p_actor: memberUid, p_audit: {} })
    dealBId = dB.data
    check('fixture deals A/B created', !dA.error && !dB.error, dA.error?.message || dB.error?.message)

    const vec1 = vecLit(randomUnitVector(768))
    const expectedName = `client-brief-smoke-0033-client-a-${stamp}`.toLowerCase()
    // NOTE: the RPC computes the name from the client's ACTUAL name + id, which we don't control the
    // exact slug of ahead of time (client name includes the stamp, so the slug should match) — verify
    // by re-deriving from the returned name instead of hardcoding, but sanity-check the PREFIX here.
    const first = await admin.rpc('upsert_client_brief', {
      p_actor: memberUid, p_client_id: clientAId, p_deal_id: dealAId,
      p_title: 'Smoke Brief v1', p_body: 'First research pass.', p_embedding: vec1, p_embedding_model: 'gemini-embedding-001',
    })
    check('upsert_client_brief first call succeeds', !first.error, first.error?.message)
    const briefName = first.data?.name
    if (briefName) memNamesToClean.push(briefName)
    check('first call reports refreshed:false, version_no:0', first.data?.refreshed === false && first.data?.version_no === 0, JSON.stringify(first.data))
    check('computed name has the deterministic client-brief-<slug>-<id8> shape', typeof briefName === 'string' && briefName.startsWith('client-brief-') && briefName.endsWith(clientAId.slice(0, 8)), briefName)

    const { data: row1 } = await admin.from('memory_entries').select('kind, source_path, client_id, deal_id, links').eq('name', briefName).maybeSingle()
    check('created entry has kind=reference', row1?.kind === 'reference', JSON.stringify(row1))
    check('created entry has source_path = null (client_brief-owned provenance, not mcp/ or memory/)', row1?.source_path === null, JSON.stringify(row1))
    check('created entry has client_id/deal_id set', row1?.client_id === clientAId && row1?.deal_id === dealAId, JSON.stringify(row1))

    // re-run for the SAME client -> update branch, versions, audit
    const second = await admin.rpc('upsert_client_brief', {
      p_actor: memberUid, p_client_id: clientAId, p_deal_id: dealAId,
      p_title: 'Smoke Brief v2', p_body: 'Deeper research pass.', p_embedding: vecLit(randomUnitVector(768)), p_embedding_model: 'gemini-embedding-001',
    })
    check('re-run for same client succeeds, refreshed:true, version_no:1', !second.error && second.data?.refreshed === true && second.data?.version_no === 1, JSON.stringify(second.data))
    check('re-run reuses the SAME deterministic name (update, not a new entry)', second.data?.name === briefName)
    const { data: verRow } = await admin.from('memory_versions').select('edited_by, change_reason, title').eq('entry_id', row1 ? (await admin.from('memory_entries').select('id').eq('name', briefName).maybeSingle()).data?.id : null).order('version_no', { ascending: false }).limit(1).maybeSingle()
    check('memory_versions row snapshots the PRIOR state w/ edited_by=machine actor + the exact change_reason', verRow?.edited_by === memberUid && verRow?.change_reason === 'prospect-research refresh' && verRow?.title === 'Smoke Brief v1', JSON.stringify(verRow))
    const { data: auditRow } = await admin.from('activity_log').select('detail').eq('action', 'agent.client_brief').eq('entity_id', clientAId).order('created_at', { ascending: false }).limit(1).maybeSingle()
    check('agent.client_brief audit row written w/ memory_name/title/refreshed', auditRow?.detail?.memory_name === briefName && auditRow?.detail?.refreshed === true, JSON.stringify(auditRow?.detail))

    // a third run -> version_no increments monotonically
    const third = await admin.rpc('upsert_client_brief', {
      p_actor: memberUid, p_client_id: clientAId, p_deal_id: dealAId,
      p_title: 'Smoke Brief v3', p_body: 'Third pass.', p_embedding: vecLit(randomUnitVector(768)), p_embedding_model: 'gemini-embedding-001',
    })
    check('third run version_no increments to 2', third.data?.version_no === 2, JSON.stringify(third.data))

    // foreign deal: dealB belongs to clientB, not clientA -> rejected
    const foreignDeal = await admin.rpc('upsert_client_brief', {
      p_actor: memberUid, p_client_id: clientAId, p_deal_id: dealBId,
      p_title: 'x', p_body: 'x', p_embedding: vecLit(randomUnitVector(768)), p_embedding_model: 'gemini-embedding-001',
    })
    check('deal belonging to a DIFFERENT client -> rejected', !!foreignDeal.error && /does not belong to client/i.test(foreignDeal.error.message ?? ''), foreignDeal.error?.message)

    // unknown client -> rejected, no auto-create
    const unknownClient = await admin.rpc('upsert_client_brief', {
      p_actor: memberUid, p_client_id: '00000000-0000-0000-0000-000000000000', p_deal_id: null,
      p_title: 'x', p_body: 'x', p_embedding: vecLit(randomUnitVector(768)), p_embedding_model: 'gemini-embedding-001',
    })
    check('unknown client -> clean error, no auto-create', !!unknownClient.error && /client .* not found/i.test(unknownClient.error.message ?? ''), unknownClient.error?.message)

    // validation: bad embedding dims, non-unit norm, missing title/body
    const badDims = await admin.rpc('upsert_client_brief', { p_actor: memberUid, p_client_id: clientAId, p_deal_id: null, p_title: 'x', p_body: 'x', p_embedding: vecLit([1, 2, 3]), p_embedding_model: 'gemini-embedding-001' })
    check('bad embedding dims -> rejected', !!badDims.error)
    const badNorm = await admin.rpc('upsert_client_brief', { p_actor: memberUid, p_client_id: clientAId, p_deal_id: null, p_title: 'x', p_body: 'x', p_embedding: vecLit(Array(768).fill(2)), p_embedding_model: 'gemini-embedding-001' })
    check('non-unit-normalized embedding -> rejected', !!badNorm.error)
    const noTitle = await admin.rpc('upsert_client_brief', { p_actor: memberUid, p_client_id: clientAId, p_deal_id: null, p_title: '', p_body: 'x', p_embedding: vecLit(randomUnitVector(768)), p_embedding_model: 'gemini-embedding-001' })
    check('empty title -> rejected', !!noTitle.error)
    const inactiveActor = await admin.rpc('upsert_client_brief', { p_actor: '00000000-0000-0000-0000-000000000000', p_client_id: clientAId, p_deal_id: null, p_title: 'x', p_body: 'x', p_embedding: vecLit(randomUnitVector(768)), p_embedding_model: 'gemini-embedding-001' })
    check('unknown/inactive actor -> rejected', !!inactiveActor.error)
  }

  // ================= 2b. CONCURRENT FIRST-CREATE (Aegis binding correction) =================
  {
    const cC = await admin.rpc('upsert_client', { p_payload: { name: `Smoke 0033 Concurrent Client ${stamp}` }, p_actor: memberUid, p_audit: {} })
    check('fixture concurrent-test client created', !cC.error, cC.error?.message)
    concurrentClientId = cC.data

    const call = (title) => admin.rpc('upsert_client_brief', {
      p_actor: memberUid, p_client_id: concurrentClientId, p_deal_id: null,
      p_title: title, p_body: `body for ${title}`, p_embedding: vecLit(randomUnitVector(768)), p_embedding_model: 'gemini-embedding-001',
    })
    const [r1, r2] = await Promise.all([call('Concurrent A'), call('Concurrent B')])
    check('two concurrent first-create calls: NEITHER surfaces an unhandled 23505/unique-violation', !r1.error && !r2.error, JSON.stringify([r1.error?.message, r2.error?.message]))
    const names = [r1.data?.name, r2.data?.name].filter(Boolean)
    check('both calls agree on the SAME computed name', names.length === 2 && names[0] === names[1], JSON.stringify(names))
    if (names[0]) memNamesToClean.push(names[0])
    const refreshedFlags = [r1.data?.refreshed, r2.data?.refreshed].sort()
    check('exactly one call created (refreshed:false), the other updated (refreshed:true) — serialized, not double-inserted', JSON.stringify(refreshedFlags) === JSON.stringify([false, true]), JSON.stringify(refreshedFlags))

    const { data: rows } = await admin.from('memory_entries').select('id').eq('name', names[0])
    check('exactly ONE memory_entries row exists for the concurrent-create name', (rows ?? []).length === 1, JSON.stringify(rows))
    const { data: versions } = await admin.from('memory_versions').select('id, change_reason').eq('entry_id', rows?.[0]?.id)
    check('exactly one memory_versions row (the update branch snapshotted the create branch exactly once)', (versions ?? []).length === 1 && versions?.[0]?.change_reason === 'prospect-research refresh', JSON.stringify(versions))
  }

  // ================= 3. STRUCTURAL AUDIENCE BOUNDARY (render-document / save-rendered-document) =====
  {
    const rClientBrief = await api('/api/render-document', { doc_type: 'client-brief', title: 'x', markdown: '# x', audience: 'client' }, memberJwt)
    check('render-document client-brief + audience:client -> 400 structural (before scan/render)', rClientBrief.status === 400 && /allowedAudiences|must be one of/i.test(rClientBrief.data?.error ?? ''), JSON.stringify(rClientBrief.data))
    const sClientBrief = await api('/api/save-rendered-document', { doc_type: 'client-brief', title: 'x', markdown: '# x', audience: 'client' }, memberJwt)
    check('save-rendered-document client-brief + audience:client -> 400 structural (before scan/render)', sClientBrief.status === 400 && /allowedAudiences|must be one of/i.test(sClientBrief.data?.error ?? ''), JSON.stringify(sClientBrief.data))

    // regression: an EXISTING type (both audiences always allowed) must be completely unaffected —
    // any response here is acceptable EXCEPT the new structural-400 message (governance-scan 422,
    // render 200, or a 503 if Browser Rendering isn't configured on this environment are all fine).
    const rWhitePaper = await api('/api/render-document', { doc_type: 'white-paper', title: 'x', markdown: '# x', audience: 'client' }, memberJwt)
    check('render-document white-paper + audience:client -> NOT the structural-400 (regression check)', !(rWhitePaper.status === 400 && /allowedAudiences|must be one of/i.test(rWhitePaper.data?.error ?? '')), JSON.stringify(rWhitePaper.data)?.slice(0, 150))

    // unauth / bad doc_type still behave exactly as before (spot-check, not a full re-run of thread 0023/0024's own smokes)
    const unauth = await api('/api/render-document', { doc_type: 'white-paper', title: 'x', markdown: '# x' }, null)
    check('render-document unauth -> 401 (unchanged)', unauth.status === 401)
  }

  // ================= 4. client_360 structural truncation (mechanism proof) =================
  // Seed synthetic documents directly (bypassing client_brief's 6/hour budget entirely) so client_360's
  // JSON payload for clientAId exceeds the 16,000-char cap, then prove the documents arm gets dropped
  // with an honest count — this proves the CAPPING MECHANISM works; it is a synthetic fixture, not a
  // claim about realistic agent-produced volume (see file header).
  {
    const seedIds = []
    for (let i = 0; i < 60; i++) {
      const id = newId()
      seedIds.push(id)
      await admin.from('documents').insert({ id, client_id: clientAId, doc_type: 'other', title: `Synthetic seed doc ${i} for truncation proof ${stamp}`, storage_path: `synthetic/${id}`, extracted_text: 'x', origin: 'draft', created_by: memberUid })
    }
    const direct = await admin.rpc('client_360', { p_client_id: clientAId })
    check('client_360 (service role) returns >60 documents pre-cap (fixture seeded correctly)', (direct.data?.documents ?? []).length >= 60, String((direct.data?.documents ?? []).length))
    // capClient360 itself is a TS function reachable only via the hosted MCP endpoint — this section
    // only proves the RPC-side fixture is large enough to WOULD force capping; the actual cap
    // assertion (truncated.documents > 0) runs live via smoke-hosted-mcp.mjs's client_360 tool call.
    for (const id of seedIds) await admin.from('documents').delete().eq('id', id)
  }

  console.log(`\n[smoke-prospect-loop] pass=${pass} fail=${fail}`)
  if (fail) process.exitCode = 1
}

main().catch((e) => { console.error('SMOKE ERROR:', e.stack || e.message); process.exitCode = 1 })
  .finally(() => cleanup())
