#!/usr/bin/env node
// Mnemosyne — thread 0032 (P2-BRIDGE + P2-CRM + P1-HYBRID) live acceptance battery.
//
// PRECONDITIONS before running against prod:
//   1. Migration 0027 applied (Aegis post-build QC + Jesse apply-go).
//   2. Code deployed (git push main; CF Pages auto-builds) — required for the endpoint-level checks
//      (client-360.ts, the extended upsert-* endpoints, vitals.ts) and the hosted-MCP recall/fetch
//      checks. The direct-RPC checks (marked DB-ONLY below) work against an applied-but-undeployed
//      migration too, per the 0024 standing deploy order (apply -> prove old code -> push).
//
// NOT covered here (inherently manual/visual, or needing an access level this script doesn't have):
//   - UI rider 1 (node-cloud animation, particles, bridge-edge rendering) — visual, needs a browser.
//   - UI rider 2 (vitals strip renders real numbers) — visual; the underlying /api/vitals + usage_events
//     read path IS covered here at the data layer.
//   - Acceptance criterion 1's "fts GIN index used (EXPLAIN on an FTS probe)" — this script has only a
//     service-role REST client (supabase-js), no arbitrary-SQL execute path, so it cannot run EXPLAIN.
//     Verify manually post-apply via the Supabase Management API / SQL editor:
//       explain analyze select name from memory_entries where fts @@ websearch_to_tsquery('english', 'x');
//     and confirm the plan shows a Bitmap Index Scan on memory_entries_fts_idx, not a Seq Scan.
//
// Run: node --env-file=.env.local scripts/smoke-bridge-crm-hybrid.mjs

import { createClient } from '@supabase/supabase-js'
import { cleanupMember } from './lib/cleanup-member.mjs'

const BASE = process.env.SMOKE_BASE || 'https://project-mnemosyne.pages.dev'
const URL = process.env.VITE_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !SERVICE || !PUB) { console.error('missing env (URL / SERVICE / PUBLISHABLE)'); process.exit(1) }

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const PW = 'Smoke!' + Math.abs(URL.length * 7919).toString(36) + 'xZ9'
const stamp = process.env.SMOKE_STAMP || String(Date.now())
const memberEmail = `smoke-0032-member-${stamp}@mnemosyne.test`
const nonmemberEmail = `smoke-0032-nonmember-${stamp}@mnemosyne.test`

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

let memberUid, nonmemberUid
let clientId, dealId, contactId
let staleDealId
let memName, memId

const UNIQUE_TOKEN = `smoke0032xyz${stamp}`

async function setup() {
  const m = await admin.auth.admin.createUser({ email: memberEmail, password: PW, email_confirm: true })
  if (m.error) throw new Error('createUser member: ' + m.error.message)
  memberUid = m.data.user.id
  const ins = await admin.from('team_members').insert({ id: memberUid, full_name: 'Smoke 0032 Member', email: memberEmail, role: 'member', active: true })
  if (ins.error) throw new Error('insert team_members: ' + ins.error.message)
  const n = await admin.auth.admin.createUser({ email: nonmemberEmail, password: PW, email_confirm: true })
  if (n.error) throw new Error('createUser nonmember: ' + n.error.message)
  nonmemberUid = n.data.user.id
}

async function cleanup() {
  try {
    if (memId) { await admin.from('memory_chunks').delete().eq('memory_entry_id', memId); await admin.from('memory_versions').delete().eq('entry_id', memId); await admin.from('activity_log').delete().eq('entity_id', memId); await admin.from('memory_entries').delete().eq('id', memId) }
    if (contactId) { await admin.from('activity_log').delete().eq('entity_id', contactId); await admin.from('contacts').delete().eq('id', contactId) }
    if (dealId) { await admin.from('activity_log').delete().eq('entity_id', dealId); await admin.from('deals').delete().eq('id', dealId) }
    if (staleDealId) { await admin.from('activity_log').delete().eq('entity_id', staleDealId); await admin.from('deals').delete().eq('id', staleDealId) }
    if (clientId) { await admin.from('activity_log').delete().eq('entity_id', clientId); await admin.from('clients').delete().eq('id', clientId) }
    // NOTE: any crm.stale_deals digest row THIS run created is already cleaned up inline, right after
    // the stale-deals test block in main() — deliberately NOT repeated here, because that inline logic
    // is the only place that knows whether the row pre-existed (real cron output, never touched) or
    // was caused by this run (safe to delete). A blanket "delete today's digest" here would risk
    // deleting real production audit data if the real 07:00 ET cron already ran today.
    await cleanupMember(admin, memberUid)
    await cleanupMember(admin, nonmemberUid)
  } catch (e) { console.error('cleanup warning:', e.message) }
}

async function main() {
  await setup()
  const memberJwt = await signIn(memberEmail)
  const nonmemberJwt = await signIn(nonmemberEmail)
  const memberClient = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { authorization: `Bearer ${memberJwt}` } } })
  const anonClient = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } })

  // ================= 1. MIGRATION POST-APPLY GATE =================
  // column existence checks via a harmless select of the new columns themselves (fails loudly if absent)
  {
    const r1 = await admin.from('memory_entries').select('client_id, deal_id, fts').limit(1)
    check('memory_entries has client_id/deal_id/fts columns', !r1.error, r1.error?.message)
    const r2 = await admin.from('documents').select('client_id, deal_id').limit(1)
    check('documents has client_id + (pre-existing) deal_id columns', !r2.error, r2.error?.message)
    const r3 = await admin.from('clients').select('industry, website, source, status').limit(1)
    check('clients has industry/website/source/status columns', !r3.error, r3.error?.message)
    const r4 = await admin.from('contacts').select('phone, linkedin, title').limit(1)
    check('contacts has phone/linkedin/title columns', !r4.error, r4.error?.message)
    const r5 = await admin.from('deals').select('next_action, follow_up_date, expected_close, updated_at').limit(1)
    check('deals has next_action/follow_up_date/expected_close/updated_at columns', !r5.error, r5.error?.message)
  }
  // RLS posture unchanged: direct member writes to the NEW columns on existing write-locked tables -> 42501
  {
    const w1 = await memberClient.from('clients').update({ industry: 'HACK' }).neq('id', '00000000-0000-0000-0000-000000000000')
    check('member direct UPDATE clients.industry -> denied', !!w1.error, w1.error?.code)
    const w2 = await memberClient.from('deals').update({ next_action: 'HACK' }).neq('id', '00000000-0000-0000-0000-000000000000')
    check('member direct UPDATE deals.next_action -> denied', !!w2.error, w2.error?.code)
  }

  // ================= 2. BRIDGE =================
  // fixture client + deal (via endpoints, exercising the CRM round-trip at the same time — see §3)
  const c = await api('/api/upsert-client', { name: `Smoke 0032 Client ${stamp}`, industry: 'Widgets', website: 'https://example.com', source: 'referral', status: 'active' }, memberJwt)
  clientId = c.data?.id
  check('create client w/ new fields -> 201', c.status === 201 && !!clientId, `status=${c.status}`)
  {
    const { data: row } = await admin.from('clients').select('industry, website, source, status').eq('id', clientId).maybeSingle()
    check('client new fields round-trip (industry/website/source/status)', row?.industry === 'Widgets' && row?.website === 'https://example.com' && row?.source === 'referral' && row?.status === 'active', JSON.stringify(row))
  }

  const d = await api('/api/upsert-deal', { title: `Smoke 0032 Deal ${stamp}`, stage: 'qualified', client_id: clientId, next_action: 'Follow up call', follow_up_date: '2026-08-01', expected_close: '2026-09-01' }, memberJwt)
  dealId = d.data?.id
  check('create deal w/ new fields -> 201', d.status === 201 && !!dealId, `status=${d.status}`)
  {
    const { data: row } = await admin.from('deals').select('next_action, follow_up_date, expected_close').eq('id', dealId).maybeSingle()
    check('deal new fields round-trip (next_action/follow_up_date/expected_close)', row?.next_action === 'Follow up call' && row?.follow_up_date === '2026-08-01' && row?.expected_close === '2026-09-01', JSON.stringify(row))
  }

  const ct = await api('/api/upsert-contact', { client_id: clientId, name: 'Smoke Contact', phone: '555-0100', linkedin: 'https://linkedin.com/in/smoke', title: 'VP Smoke' }, memberJwt)
  contactId = ct.data?.id
  check('create contact w/ new fields -> 201', ct.status === 201 && !!contactId, `status=${ct.status}`)
  {
    const { data: row } = await admin.from('contacts').select('phone, linkedin, title').eq('id', contactId).maybeSingle()
    check('contact new fields round-trip (phone/linkedin/title)', row?.phone === '555-0100' && row?.linkedin === 'https://linkedin.com/in/smoke' && row?.title === 'VP Smoke', JSON.stringify(row))
  }

  // ingest a fixture memory entry directly (DB-ONLY: ingest_memory_entry is service-role-only, no
  // endpoint exposes it — random unit vector avoids needing GEMINI_API_KEY for a smoke script)
  memName = `smoke-0032-bridge-${stamp}`
  const vec1 = vecLit(randomUnitVector(768))
  const bridgeBody = `# Overview\nThis is the ${UNIQUE_TOKEN} fixture entry.\n\n## Scope\nscope section body, line one.\nline two.\n\n### Scope details\na nested sub-heading.\n\n## Timeline\ntimeline section body.\n`
  const ingestRes = await admin.rpc('ingest_memory_entry', {
    payload: { name: memName, kind: 'reference', title: `Smoke 0032 bridge fixture ${stamp}`, body: bridgeBody, links: [], source_path: `memory/${memName}.md`, embedding_model: 'gemini-embedding-001', embedding: vec1, chunks: [], client_id: clientId, deal_id: dealId },
  })
  check('ingest_memory_entry accepts client_id/deal_id', !ingestRes.error, ingestRes.error?.message)
  {
    const { data: row } = await admin.from('memory_entries').select('id, client_id, deal_id, updated_at').eq('name', memName).maybeSingle()
    memId = row?.id
    check('ingested entry has client_id/deal_id set', row?.client_id === clientId && row?.deal_id === dealId, JSON.stringify(row))

    // bad FK -> clean error, not a raw constraint violation
    const badFk = await admin.rpc('ingest_memory_entry', { payload: { name: `${memName}-badfk`, kind: 'reference', title: 'x', body: 'x', links: [], source_path: `memory/${memName}-badfk.md`, embedding_model: 'gemini-embedding-001', embedding: vecLit(randomUnitVector(768)), chunks: [], client_id: '00000000-0000-0000-0000-000000000000' } })
    check('ingest_memory_entry bad client_id -> clean error', !!badFk.error && /client .* not found/i.test(badFk.error.message ?? ''), badFk.error?.message)

    // update_memory: link-only change (same content, drop deal_id) -> memory.link audit row w/ old/new + bumps updated_at
    const priorUpdatedAt = row.updated_at
    const upd = await admin.rpc('update_memory', {
      p_payload: { name: memName, kind: 'reference', title: `Smoke 0032 bridge fixture ${stamp}`, body: bridgeBody, links: [], embedding_model: 'gemini-embedding-001', embedding: vec1, chunks: [], deal_id: null },
      p_actor: memberUid, p_audit: { change_reason: 'smoke 0032 link-update fixture' }, p_expected_updated_at: priorUpdatedAt,
    })
    check('update_memory link-only change succeeds', !upd.error, upd.error?.message)
    const { data: linkAudit } = await admin.from('activity_log').select('detail').eq('entity_id', memId).eq('action', 'memory.link').order('created_at', { ascending: false }).limit(1).maybeSingle()
    check('memory.link audit row written w/ field/old/new', linkAudit?.detail?.field === 'deal_id' && linkAudit?.detail?.old === dealId && linkAudit?.detail?.new === null, JSON.stringify(linkAudit?.detail))
    const { data: afterRow } = await admin.from('memory_entries').select('updated_at, deal_id').eq('id', memId).maybeSingle()
    check('link-only update bumped updated_at', afterRow?.updated_at !== priorUpdatedAt)
    check('link-only update actually cleared deal_id', afterRow?.deal_id === null)

    // stale expected_updated_at on a link-only update -> concurrency error (using the NOW-STALE priorUpdatedAt again)
    const staleUpd = await admin.rpc('update_memory', {
      p_payload: { name: memName, kind: 'reference', title: `Smoke 0032 bridge fixture ${stamp}`, body: bridgeBody, links: [], embedding_model: 'gemini-embedding-001', embedding: vec1, chunks: [], client_id: clientId },
      p_actor: memberUid, p_audit: { change_reason: 'smoke 0032 link-update fixture' }, p_expected_updated_at: priorUpdatedAt,
    })
    check('stale expected_updated_at on link-only update -> concurrency error', !!staleUpd.error && /changed since you read it/i.test(staleUpd.error.message ?? ''), staleUpd.error?.message)

    // restore deal_id for later filter tests, using the CURRENT updated_at
    const { data: curRow } = await admin.from('memory_entries').select('updated_at').eq('id', memId).maybeSingle()
    await admin.rpc('update_memory', {
      p_payload: { name: memName, kind: 'reference', title: `Smoke 0032 bridge fixture ${stamp}`, body: bridgeBody, links: [], embedding_model: 'gemini-embedding-001', embedding: vec1, chunks: [], deal_id: dealId },
      p_actor: memberUid, p_audit: { change_reason: 'smoke 0032 link-update fixture' }, p_expected_updated_at: curRow.updated_at,
    })

    // fix round (Aegis post-build QC, 2026-07-02): ingest_memory_entry's ON CONFLICT must use the SAME
    // omitted-vs-explicit-null convention as update_memory — a re-ingest that OMITS client_id/deal_id
    // keys must PRESERVE the entry's existing links (a canonical memory/*.md re-ingest must never
    // silently unlink a memory from its client/deal); a re-ingest with an EXPLICIT null must CLEAR it.
    // Both directions go through the same ON CONFLICT branch, so both must bump updated_at.
    const baseIngestPayload = { name: memName, kind: 'reference', title: `Smoke 0032 bridge fixture ${stamp} v2`, body: bridgeBody, links: [], source_path: `memory/${memName}.md`, embedding_model: 'gemini-embedding-001', embedding: vec1, chunks: [] }

    // (a) re-ingest WITHOUT client_id/deal_id keys at all -> both links preserved, updated_at bumped
    const beforeOmit = (await admin.from('memory_entries').select('updated_at, client_id, deal_id').eq('id', memId).maybeSingle()).data
    const reingestOmit = await admin.rpc('ingest_memory_entry', { payload: baseIngestPayload })
    check('re-ingest omitting client_id/deal_id -> no error', !reingestOmit.error, reingestOmit.error?.message)
    const afterOmit = (await admin.from('memory_entries').select('updated_at, client_id, deal_id').eq('id', memId).maybeSingle()).data
    check('re-ingest omitting bridge keys PRESERVES client_id', afterOmit?.client_id === beforeOmit?.client_id && afterOmit?.client_id === clientId, JSON.stringify(afterOmit))
    check('re-ingest omitting bridge keys PRESERVES deal_id', afterOmit?.deal_id === beforeOmit?.deal_id && afterOmit?.deal_id === dealId, JSON.stringify(afterOmit))
    check('re-ingest omitting bridge keys still bumps updated_at', afterOmit?.updated_at !== beforeOmit?.updated_at)

    // (b) re-ingest WITH explicit client_id: null (deal_id key still absent) -> client_id CLEARED, deal_id preserved
    const reingestClear = await admin.rpc('ingest_memory_entry', { payload: { ...baseIngestPayload, client_id: null } })
    check('re-ingest w/ explicit client_id:null -> no error', !reingestClear.error, reingestClear.error?.message)
    const afterClear = (await admin.from('memory_entries').select('updated_at, client_id, deal_id').eq('id', memId).maybeSingle()).data
    check('re-ingest w/ explicit null CLEARS client_id', afterClear?.client_id === null, JSON.stringify(afterClear))
    check('re-ingest w/ explicit null on client_id still PRESERVES deal_id (key absent)', afterClear?.deal_id === dealId, JSON.stringify(afterClear))
    check('re-ingest w/ explicit null still bumps updated_at', afterClear?.updated_at !== afterOmit?.updated_at)

    // restore client_id for later client_360/hybrid-filter tests
    const restoreIngest = await admin.rpc('ingest_memory_entry', { payload: { ...baseIngestPayload, client_id: clientId, deal_id: dealId } })
    check('re-ingest restoring both links -> no error', !restoreIngest.error, restoreIngest.error?.message)
    const afterRestore = (await admin.from('memory_entries').select('client_id, deal_id').eq('id', memId).maybeSingle()).data
    check('bridge fixture restored to client_id+deal_id set for downstream checks', afterRestore?.client_id === clientId && afterRestore?.deal_id === dealId, JSON.stringify(afterRestore))
  }

  // client_360
  {
    const direct = await admin.rpc('client_360', { p_client_id: clientId })
    const shapeOk = direct.data && Array.isArray(direct.data.contacts) && Array.isArray(direct.data.deals) && Array.isArray(direct.data.memories) && Array.isArray(direct.data.documents) && Array.isArray(direct.data.activity) && direct.data.client?.id === clientId
    check('client_360 (service role) returns the full fixture shape', shapeOk, JSON.stringify(direct.data)?.slice(0, 200))
    check('client_360 memories include the bridge fixture entry', (direct.data?.memories ?? []).some((m) => m.name === memName))
    check('client_360 deals include the fixture deal', (direct.data?.deals ?? []).some((d2) => d2.id === dealId))
    check('client_360 contacts include the fixture contact', (direct.data?.contacts ?? []).some((ct2) => ct2.id === contactId))

    // direct RPC execute as anon/authenticated -> denied (not service-role)
    const anonRpc = await anonClient.rpc('client_360', { p_client_id: clientId })
    check('client_360 direct execute as anon -> denied', !!anonRpc.error, anonRpc.error?.message)
    const memberRpc = await memberClient.rpc('client_360', { p_client_id: clientId })
    check('client_360 direct execute as authenticated -> denied', !!memberRpc.error, memberRpc.error?.message)

    // endpoint: anon -> 401, non-member -> 403, member -> 200 + shape
    check('POST /api/client-360 unauth -> 401', (await api('/api/client-360', { client_id: clientId }, null)).status === 401)
    check('POST /api/client-360 non-member -> 403', (await api('/api/client-360', { client_id: clientId }, nonmemberJwt)).status === 403)
    const ep = await api('/api/client-360', { client_id: clientId }, memberJwt)
    check('POST /api/client-360 member -> 200 + client row', ep.status === 200 && ep.data?.client?.id === clientId, `status=${ep.status}`)
    check('POST /api/client-360 bad uuid -> 400', (await api('/api/client-360', { client_id: 'nope' }, memberJwt)).status === 400)
    check('POST /api/client-360 unknown client -> 404', (await api('/api/client-360', { client_id: '00000000-0000-0000-0000-000000000000' }, memberJwt)).status === 404)
  }

  // ================= 3. CRM: auth/validation paths for the 3 write endpoints (round-trip already proven above) =================
  check('upsert-client bad source -> 400', (await api('/api/upsert-client', { name: 'x', source: 'bogus' }, memberJwt)).status === 400)
  check('upsert-client bad status -> 400', (await api('/api/upsert-client', { name: 'x', status: 'bogus' }, memberJwt)).status === 400)
  check('upsert-deal bad follow_up_date -> 400', (await api('/api/upsert-deal', { title: 'x', stage: 'lead', follow_up_date: 'not-a-date' }, memberJwt)).status === 400)
  check('upsert-contact phone too long -> 400', (await api('/api/upsert-contact', { client_id: clientId, name: 'x', phone: '5'.repeat(41) }, memberJwt)).status === 400)

  // ---- stale-deal digest ----
  {
    // run_stale_deals_digest is itself same-day idempotent: if the real 07:00 ET cron already fired
    // today (independent of this smoke run), calling it again is a documented no-op and our fixture
    // deal would NOT be folded into an already-written digest. Detect that BEFORE creating the
    // fixture, fetching ALL crm.stale_deals rows and filtering by digest_date in JS (no raw
    // PostgREST jsonb-path filter string — no precedent for that syntax in this codebase; see
    // brief.ts's own note on this). Assertions that depend on OUR fixture being included are only
    // made when we're confident WE caused the day's row; the idempotency assertion itself (row count
    // stays at exactly one across repeated calls) holds true either way and is always checked.
    const today = new Date().toISOString().slice(0, 10)
    const digestRowsForToday = async () => {
      const { data } = await admin.from('activity_log').select('id, detail').eq('action', 'crm.stale_deals')
      return (data ?? []).filter((r) => r.detail?.digest_date === today)
    }
    const preExisting = await digestRowsForToday()
    const hadDigestAlready = preExisting.length > 0
    if (hadDigestAlready) console.log(`  [stale-deals] a crm.stale_deals digest for ${today} already exists (real cron already ran) — skipping fixture-content assertions, idempotency-only checks still run`)

    const sd = await api('/api/upsert-deal', { title: `Smoke 0032 Stale Deal ${stamp}`, stage: 'qualified', client_id: clientId, follow_up_date: '2020-01-01' }, memberJwt)
    staleDealId = sd.data?.id
    check('stale-deal fixture created', sd.status === 201 && !!staleDealId, `status=${sd.status}`)
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()
    await admin.from('activity_log').update({ created_at: twentyDaysAgo }).eq('entity_type', 'deals').eq('entity_id', staleDealId).eq('action', 'crm.deal_save')

    const digestBefore = await admin.rpc('run_stale_deals_digest', {})
    check('run_stale_deals_digest executes without error', !digestBefore.error, digestBefore.error?.message)
    const rowsAfterFirst = await digestRowsForToday()
    check('exactly one crm.stale_deals row for today after first run', rowsAfterFirst.length === 1, `count=${rowsAfterFirst.length}`)

    if (!hadDigestAlready) {
      const digestDetail = rowsAfterFirst[0]?.detail
      check('digest detail has stale_count >= 1', typeof digestDetail?.stale_count === 'number' && digestDetail.stale_count >= 1, JSON.stringify(digestDetail))
      check('digest deals_json (string, flat detail) mentions the fixture deal title', typeof digestDetail?.deals_json === 'string' && digestDetail.deals_json.includes(`Smoke 0032 Stale Deal ${stamp}`), digestDetail?.deals_json?.slice(0, 200))
      const { data: digestActorRow } = await admin.from('activity_log').select('actor_id').eq('id', rowsAfterFirst[0].id).maybeSingle()
      check('digest actor_id is null (documented system actor)', digestActorRow?.actor_id === null)
    }

    // second run same day -> no duplicate (holds regardless of who caused the first row)
    await admin.rpc('run_stale_deals_digest', {})
    const rowsAfterSecond = await digestRowsForToday()
    check('second same-day run -> still exactly one digest row (idempotent)', rowsAfterSecond.length === 1, `count=${rowsAfterSecond.length}`)

    // cleanup: only remove the digest row if THIS run created it — a pre-existing (real) digest row
    // must never be touched by a smoke script.
    if (!hadDigestAlready) for (const r of rowsAfterSecond) await admin.from('activity_log').delete().eq('id', r.id)

    // exactly one cron job registered
    const { data: cronJobs, error: cronErr } = await admin.from('cron.job').select('jobname').eq('jobname', 'mnemosyne_stale_deals_daily')
    // cron.job lives in the cron schema, which PostgREST does not expose — a Data API query CANNOT
    // see it (verified live 2026-07-03). Job existence/uniqueness is proven by the post-apply SQL
    // gate (select count(*) from cron.job where jobname='mnemosyne_stale_deals_daily' -> 1); here we
    // only assert the Data API behaved as expected (error or empty), i.e. no accidental exposure.
    if (cronErr) check('cron.job not exposed via Data API (existence proven by post-apply SQL gate)', true)
    else check('cron.job not exposed via Data API (existence proven by post-apply SQL gate)', (cronJobs ?? []).length <= 1, `unexpected rows=${cronJobs?.length}`)
  }

  // ================= 4. HYBRID =================
  {
    // FTS arm: exact-token query with a DELIBERATELY RANDOM (non-matching) embedding — any high rank
    // for the fixture entry must come from the FTS arm, not vector similarity, proving fusion works.
    const randomEmbedding = vecLit(randomUnitVector(768))
    const ftsRes = await admin.rpc('recall_memory_hybrid', { p_query: UNIQUE_TOKEN, p_embedding: randomEmbedding, p_match_count: 10 })
    check('recall_memory_hybrid executes', !ftsRes.error, ftsRes.error?.message)
    const ftsHit = (ftsRes.data ?? []).find((r) => r.name === memName)
    check('exact-token query ranks the fixture entry (FTS arm) despite a random embedding', !!ftsHit, JSON.stringify((ftsRes.data ?? []).map((r) => r.name)))
    check('matched_via reflects the fts/both arm for the exact-token hit', ftsHit && (ftsHit.matched_via === 'fts' || ftsHit.matched_via === 'both'), ftsHit?.matched_via)

    // filters: client_id filter should include the fixture (linked) and NOT an unrelated entry
    const unrelatedName = `smoke-0032-unrelated-${stamp}`
    await admin.rpc('ingest_memory_entry', { payload: { name: unrelatedName, kind: 'reference', title: 'unrelated', body: `${UNIQUE_TOKEN} but unrelated to any client`, links: [], source_path: `memory/${unrelatedName}.md`, embedding_model: 'gemini-embedding-001', embedding: vecLit(randomUnitVector(768)), chunks: [] } })
    const filteredRes = await admin.rpc('recall_memory_hybrid', { p_query: UNIQUE_TOKEN, p_embedding: randomEmbedding, p_match_count: 10, p_client_id: clientId })
    const filteredNames = (filteredRes.data ?? []).map((r) => r.name)
    check('client_id filter includes the linked fixture entry', filteredNames.includes(memName), filteredNames.join(','))
    check('client_id filter excludes the unrelated entry', !filteredNames.includes(unrelatedName), filteredNames.join(','))
    await admin.from('memory_entries').delete().eq('name', unrelatedName)

    // old recall_memory(vector,int) untouched — still works standalone
    const oldRes = await admin.rpc('recall_memory', { query_embedding: randomEmbedding, match_count: 5 })
    check('old recall_memory(vector,int) still works, untouched by this migration', !oldRes.error, oldRes.error?.message)

    // recall_memory_hybrid denied to anon/authenticated (service-role-only)
    const anonHybrid = await anonClient.rpc('recall_memory_hybrid', { p_query: 'x', p_embedding: randomEmbedding })
    check('recall_memory_hybrid direct execute as anon -> denied', !!anonHybrid.error, anonHybrid.error?.message)
    const memberHybrid = await memberClient.rpc('recall_memory_hybrid', { p_query: 'x', p_embedding: randomEmbedding })
    check('recall_memory_hybrid direct execute as authenticated -> denied', !!memberHybrid.error, memberHybrid.error?.message)
  }

  // ================= 5. FETCH-SCOPE (live, via a direct fetch-core-equivalent RPC check) =================
  // (exhaustive logic already proven keyless in mcp/test-fetch.mjs, 75/75 incl. redact-before-section
  // security proofs — this is a live end-to-end confirmation that get_memory_entry serves the fixture
  // body correctly for the sectioning logic to run against, not a re-test of the sectioning itself)
  {
    const entry = await admin.rpc('get_memory_entry', { p_name: memName })
    const row = Array.isArray(entry.data) ? entry.data[0] : entry.data
    check('get_memory_entry serves the fixture body with real markdown headings', !!row?.body?.includes('## Scope') && !!row?.body?.includes('## Timeline'))
  }

  // ================= 6b. VITALS (UI rider 2 data layer — the visual strip itself needs a browser) ====
  {
    check('GET /api/vitals unauth -> 401', (await api('/api/vitals', null, null, 'GET')).status === 401)
    check('GET /api/vitals non-member -> 403', (await api('/api/vitals', null, nonmemberJwt, 'GET')).status === 403)
    const vit = await api('/api/vitals', null, memberJwt, 'GET')
    check('GET /api/vitals member -> 200 + numeric activeMachines', vit.status === 200 && typeof vit.data?.activeMachines === 'number', JSON.stringify(vit.data))
    // never exposes token hashes/labels/member_id — response is a bare count only
    check('vitals response carries no token/hash/label fields', vit.data && !('token_hash' in vit.data) && !('label' in vit.data) && !('member_id' in vit.data))
  }

  // ================= 6. BRIEF (name-normalization fix) =================
  {
    // exec-pro repro: a display-name slug should now resolve via projects_fk (thread 0030's backfill
    // already mapped "intellioptics-2-5" -> project "IntelliOptics 2.5"; this proves the slug-match
    // arm added in this unit, not just that the backfill happened).
    const { data: proj } = await admin.from('projects').select('id, name').ilike('name', 'IntelliOptics 2.5').maybeSingle()
    if (proj) {
      // call runBrief indirectly is not possible from a plain script (it's a .ts module) -- this is
      // covered live via the hosted MCP brief tool in scripts/smoke-hosted-mcp.mjs's additions.
      check('IntelliOptics 2.5 project exists for the brief exec-pro repro (see smoke-hosted-mcp.mjs)', true)
    } else {
      check('IntelliOptics 2.5 project exists for the brief exec-pro repro', false, 'not found — thread 0030 backfill may not have run on this DB')
    }
  }

  console.log(`\n[smoke-bridge-crm-hybrid] pass=${pass} fail=${fail}`)
  if (fail) process.exitCode = 1
}

main().catch((e) => { console.error('SMOKE ERROR:', e.stack || e.message); process.exitCode = 1 })
  .finally(() => cleanup())
