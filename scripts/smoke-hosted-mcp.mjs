#!/usr/bin/env node
// Mnemosyne — thread 0027 (P1-HOSTED-MCP + P1-BRIEF) live acceptance battery.
//
// PRECONDITIONS before running against prod:
//   1. Migration 0026 applied (Aegis post-build QC + Jesse apply-go).
//   2. functions/api/mcp.ts deployed (git push main; CF Pages auto-builds).
//   3. 🔴 Service-role key ROTATED + CF Pages env updated + redeployed + all existing smokes green
//      (render 19/19, telemetry 14/14, log-update 15/15) — thread 0027's hard gate. This script does
//      NOT and CANNOT verify rotation happened; that's an operational step, not a code path.
//
// NOT covered here (inherently manual, not scriptable):
//   - Acceptance criterion 10 (a real second-machine Claude Code session running `claude mcp add`).
//   - The rotation gate itself (criterion 9) — the runbook, not a test.
//
// Uses fixture data (a throwaway project + memory/documents/activity rows) to exercise `brief` fully,
// independent of whether the REAL `projects` table has been populated yet — see thread 0027 build
// notes for the separate, real finding that `projects` has 0 rows in prod today.
//
// Run: node --env-file=.env.local scripts/smoke-hosted-mcp.mjs

import { createClient } from '@supabase/supabase-js'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { cleanupMember } from './lib/cleanup-member.mjs'

const BASE = process.env.SMOKE_BASE || 'https://project-mnemosyne.pages.dev'
const ENDPOINT = `${BASE}/api/mcp`
const URL = process.env.VITE_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !SERVICE) { console.error('missing env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)'); process.exit(1) }

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const stamp = process.env.SMOKE_STAMP || String(Date.now())

let pass = 0, fail = 0
function check(name, ok, extra = '') { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

function mintToken() {
  const token = 'mnk_' + randomBytes(32).toString('base64url')
  return { token, hash: createHash('sha256').update(token).digest('hex') }
}

async function createMachine(label, scopes, active = true) {
  const id = randomUUID()
  const { error } = await admin.from('team_members').insert({ id, full_name: label, email: null, kind: 'machine', scopes, active })
  if (error) throw new Error(`createMachine(${label}): ${error.message}`)
  return id
}

async function insertToken(memberId, hash, label, { expiresAt = null, revokedAt = null } = {}) {
  const { error } = await admin.from('machine_tokens').insert({ member_id: memberId, token_hash: hash, label, expires_at: expiresAt, revoked_at: revokedAt })
  if (error) throw new Error(`insertToken(${label}): ${error.message}`)
}

async function call(token, body, headers = {}) {
  const h = { 'content-type': 'application/json', accept: 'application/json', ...headers }
  if (token !== null) h.authorization = `Bearer ${token}`
  const res = await fetch(ENDPOINT, { method: headers.__method || 'POST', headers: h, body: headers.__method === 'GET' ? undefined : JSON.stringify(body) })
  let json = null
  const text = await res.text()
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON (e.g. 405/406 plain body) tolerated */ }
  return { status: res.status, headers: res.headers, json, text }
}

const rpcReq = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params })
const rpcNotif = (method, params) => ({ jsonrpc: '2.0', method, params }) // no id -> notification

// ---- fixture ids, filled in setup() ----
let fullMachineId, fullToken
let limitedMachineId, limitedToken
let revokeMachineId, revokeToken
let deactivatedMachineId, deactivatedToken
let humanRowId, humanRowToken
let projectId, projectName, secretEntryName

async function setup() {
  // full-scope machine (primary positive-path actor)
  fullMachineId = await createMachine(`smoke-mcp-full-${stamp}`, ['recall', 'fetch', 'log_update', 'brief'])
  ;({ token: fullToken } = await (async () => { const t = mintToken(); await insertToken(fullMachineId, t.hash, 'full'); return t })())

  // limited-scope machine (recall only) — out-of-scope + tools/list-scoping tests
  limitedMachineId = await createMachine(`smoke-mcp-limited-${stamp}`, ['recall'])
  ;({ token: limitedToken } = await (async () => { const t = mintToken(); await insertToken(limitedMachineId, t.hash, 'limited'); return t })())

  // a machine whose token we'll revoke mid-test
  revokeMachineId = await createMachine(`smoke-mcp-revoke-${stamp}`, ['recall'])
  ;({ token: revokeToken } = await (async () => { const t = mintToken(); await insertToken(revokeMachineId, t.hash, 'revoke-me'); return t })())

  // a deactivated machine with an otherwise-valid, non-revoked, non-expired token
  deactivatedMachineId = await createMachine(`smoke-mcp-deactivated-${stamp}`, ['recall'], false)
  ;({ token: deactivatedToken } = await (async () => { const t = mintToken(); await insertToken(deactivatedMachineId, t.hash, 'deactivated'); return t })())

  // thread 0029 item 3: a token minted against a kind='human' row (a mis-provisioning scenario) must
  // be dead on arrival — same 401 as any other bad token. Only valid post-0026 (the auth.users FK is
  // dropped there; pre-0026 this insert would itself fail, which is fine — this script only runs
  // meaningfully post-apply anyway, since verify_machine_token doesn't exist before it).
  humanRowId = randomUUID()
  const { error: humanErr } = await admin.from('team_members').insert({ id: humanRowId, full_name: `smoke-mcp-human-${stamp}`, email: null, kind: 'human', scopes: ['recall'], active: true })
  if (humanErr) throw new Error(`human row fixture: ${humanErr.message}`)
  ;({ token: humanRowToken } = await (async () => { const t = mintToken(); await insertToken(humanRowId, t.hash, 'human-row'); return t })())

  // brief fixture: a throwaway project + linked resume memory (with an embedded secret, for the
  // redaction test) + a doc + an activity row (both FK-linked AND detail-linked, to prove both paths)
  projectName = `Smoke MCP Project ${stamp}`
  const { data: proj, error: projErr } = await admin.from('projects').insert({ name: projectName }).select('id').single()
  if (projErr) throw new Error(`project fixture: ${projErr.message}`)
  projectId = proj.id

  secretEntryName = `smoke-mcp-resume-${stamp}`
  const bigResume = `# ${projectName} RESUME\n\n🔴 OPEN: finish the smoke test\n📋 NEXT: ship it\n\n` +
    'contaminated body sk_live_' + 'x'.repeat(24) + ' end\n' + 'z'.repeat(9000)
  const { error: memErr } = await admin.from('memory_entries').insert({
    name: secretEntryName, kind: 'project', title: `${projectName} resume`, body: bigResume,
    project_id: projectId, links: [],
  })
  if (memErr) throw new Error(`memory fixture: ${memErr.message}`)

  const { error: docErr } = await admin.from('documents').insert({ project_id: projectId, doc_type: 'other', title: 'Smoke fixture doc' })
  if (docErr) throw new Error(`document fixture: ${docErr.message}`)

  const { error: actErr } = await admin.from('activity_log').insert({
    actor_id: fullMachineId, action: 'agent.note', entity_type: 'project', entity_id: projectId, detail: { note: 'fixture activity row' },
  })
  if (actErr) throw new Error(`activity fixture: ${actErr.message}`)
}

async function cleanup() {
  try {
    // FK-drop-safe (thread 0029): cleanupMember deletes actor-keyed activity_log/usage_events/
    // rate_limits, tries a real team_members delete, falls back to deactivate if something still
    // blocks it, then best-effort deleteUser (harmless no-op for these — machines have no real auth
    // user). machine_tokens isn't actor-keyed the same way, so it's deleted separately here.
    for (const id of [fullMachineId, limitedMachineId, revokeMachineId, deactivatedMachineId, humanRowId]) {
      if (!id) continue
      await admin.from('machine_tokens').delete().eq('member_id', id)
      await cleanupMember(admin, id)
    }
    if (projectId) {
      await admin.from('activity_log').delete().eq('entity_id', projectId)
      await admin.from('documents').delete().eq('project_id', projectId)
      await admin.from('memory_entries').delete().eq('project_id', projectId)
      await admin.from('projects').delete().eq('id', projectId)
    }
  } catch (e) { console.error('cleanup warning:', e.message) }
}

async function main() {
  await setup()

  // ================= 1. AUTH BATTERY =================
  const noAuth = await call(null, rpcReq('initialize', {}))
  check('no Authorization header -> 401', noAuth.status === 401)

  const malformed = await call('not-a-real-token', rpcReq('initialize', {}))
  check('malformed token -> 401', malformed.status === 401)

  const unknown = await call('mnk_' + randomBytes(32).toString('base64url'), rpcReq('initialize', {}))
  check('unknown (never-issued) token -> 401', unknown.status === 401)

  const revokedTok = mintToken()
  await insertToken(revokeMachineId, revokedTok.hash, 'pre-revoked', { revokedAt: new Date().toISOString() })
  const revokedRes = await call(revokedTok.token, rpcReq('initialize', {}))
  check('revoked token -> 401', revokedRes.status === 401)

  const expiredTok = mintToken()
  await insertToken(revokeMachineId, expiredTok.hash, 'pre-expired', { expiresAt: new Date(Date.now() - 60_000).toISOString() })
  const expiredRes = await call(expiredTok.token, rpcReq('initialize', {}))
  check('expired token -> 401', expiredRes.status === 401)

  const deactivatedRes = await call(deactivatedToken, rpcReq('initialize', {}))
  check('deactivated member (valid token) -> 401', deactivatedRes.status === 401)

  const humanRowRes = await call(humanRowToken, rpcReq('initialize', {}))
  check('token minted against a kind=human row -> 401 (thread 0029 item 3)', humanRowRes.status === 401)

  const bodies = [noAuth, malformed, unknown, revokedRes, expiredRes, deactivatedRes, humanRowRes].map((r) => JSON.stringify(r.json))
  check('all 401s are byte-identical (no oracle)', new Set(bodies).size === 1, bodies[0])

  const outOfScope = await call(limitedToken, rpcReq('tools/call', { name: 'fetch', arguments: { name: 'x' } }))
  check('valid token + out-of-scope tool -> 403', outOfScope.status === 403)
  const limitedList = await call(limitedToken, rpcReq('tools/list', {}))
  const limitedNames = (limitedList.json?.result?.tools ?? []).map((t) => t.name)
  check('tools/list never lists an out-of-scope tool', !limitedNames.includes('fetch') && limitedNames.includes('recall'))

  // ================= 2. PROTOCOL BATTERY =================
  const init = await call(fullToken, rpcReq('initialize', {}))
  check('initialize -> 200 + negotiated version + capabilities', init.status === 200 && init.json?.result?.protocolVersion === '2025-06-18' && !!init.json?.result?.capabilities?.tools && init.json?.result?.serverInfo?.name === 'mnemosyne')

  const fullList = await call(fullToken, rpcReq('tools/list', {}))
  const fullNames = (fullList.json?.result?.tools ?? []).map((t) => t.name).sort()
  check('tools/list (full scope) -> exactly the 4 tools with schemas', JSON.stringify(fullNames) === JSON.stringify(['brief', 'fetch', 'log_update', 'recall']) && fullList.json.result.tools.every((t) => !!t.inputSchema))

  const recallCall = await call(fullToken, rpcReq('tools/call', { name: 'recall', arguments: { query: 'smoke test orientation query', k: 3 } }))
  check('tools/call recall round-trips', recallCall.status === 200 && !recallCall.json?.result?.isError)

  const fetchMiss = await call(fullToken, rpcReq('tools/call', { name: 'fetch', arguments: { name: 'no-such-entry-' + stamp } }))
  check('tools/call fetch round-trips (clean miss, not an error)', fetchMiss.status === 200 && !fetchMiss.json?.result?.isError)

  const logUpdateCall = await call(fullToken, rpcReq('tools/call', { name: 'log_update', arguments: { action: 'agent.note', detail: { note: 'smoke round-trip' } } }))
  check('tools/call log_update round-trips', logUpdateCall.status === 200 && !logUpdateCall.json?.result?.isError)

  const briefCall = await call(fullToken, rpcReq('tools/call', { name: 'brief', arguments: { project: projectName } }))
  check('tools/call brief round-trips', briefCall.status === 200 && !briefCall.json?.result?.isError)

  const notif = await call(fullToken, rpcNotif('notifications/initialized', {}))
  check('notification (no id) -> 202 empty body', notif.status === 202 && notif.text === '')

  const getRes = await call(fullToken, {}, { __method: 'GET' })
  check('GET -> 405 with Allow header', getRes.status === 405 && (getRes.headers.get('allow') || '').includes('POST'))

  const putRes = await fetch(ENDPOINT, { method: 'PUT', headers: { authorization: `Bearer ${fullToken}` } })
  check('PUT -> 405 with Allow header', putRes.status === 405 && (putRes.headers.get('allow') || '').includes('POST'))

  const optionsRes = await fetch(ENDPOINT, { method: 'OPTIONS', headers: { authorization: `Bearer ${fullToken}` } })
  check('OPTIONS -> 405 with Allow header (v1 is CLI/server-side only, no CORS preflight)', optionsRes.status === 405 && (optionsRes.headers.get('allow') || '').includes('POST'))

  // thread 0029 blocker #2: Content-Length is trusted only as a fast-path; a chunked body with NO
  // Content-Length header must still be rejected BEFORE JSON.parse once it exceeds the real cap.
  // Node's fetch omits Content-Length when the body is an async generator (unknown length upfront),
  // forcing chunked transfer-encoding — exactly the bypass class Aegis flagged.
  async function* oversizedChunks() { const chunk = 'x'.repeat(8192); for (let i = 0; i < 10; i++) yield chunk } // 80KB > 64KB cap, no declared length
  const chunkedOversized = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${fullToken}`, 'content-type': 'application/json', accept: 'application/json' },
    body: oversizedChunks(),
    duplex: 'half',
  })
  check('oversized chunked body (no Content-Length) -> 413 before parse', chunkedOversized.status === 413, `status=${chunkedOversized.status}`)

  const badAccept = await call(fullToken, rpcReq('initialize', {}), { accept: 'text/plain' })
  check('Accept: text/plain only -> 406', badAccept.status === 406)

  const sseAccept = await call(fullToken, rpcReq('initialize', {}), { accept: 'text/event-stream' })
  check('Accept: text/event-stream alone -> served (200)', sseAccept.status === 200)

  const badVersion = await call(fullToken, rpcReq('initialize', {}), { 'mcp-protocol-version': '1999-01-01' })
  check('unsupported MCP-Protocol-Version -> 400 naming supported versions', badVersion.status === 400 && Array.isArray(badVersion.json?.supported))

  const absentVersion = await call(fullToken, rpcReq('initialize', {}))
  check('absent MCP-Protocol-Version -> served', absentVersion.status === 200)

  const foreignOrigin = await call(fullToken, rpcReq('initialize', {}), { origin: 'https://evil.example.com' })
  check('foreign Origin -> 403 pre-auth', foreignOrigin.status === 403)
  const foreignOriginBadToken = await call('bogus', rpcReq('initialize', {}), { origin: 'https://evil.example.com' })
  check('foreign Origin -> 403 even with an invalid token (proves pre-auth ordering)', foreignOriginBadToken.status === 403)
  const claudeAiOrigin = await call(fullToken, rpcReq('initialize', {}), { origin: 'https://claude.ai' })
  check('browser-hosted claude.ai Origin -> 403 (thread 0029 item 4: v1 is CLI/server-side only)', claudeAiOrigin.status === 403)

  const absentOrigin = await call(fullToken, rpcReq('initialize', {}))
  check('absent Origin -> served', absentOrigin.status === 200)
  const prodOrigin = await call(fullToken, rpcReq('initialize', {}), { origin: 'https://project-mnemosyne.pages.dev' })
  check('matching prod Origin -> served', prodOrigin.status === 200)

  const straySession = await call(fullToken, rpcReq('initialize', {}), { 'mcp-session-id': 'bogus-session-id' })
  check('stray Mcp-Session-Id -> ignored, still served', straySession.status === 200)

  // ================= 3. CAPS =================
  const bigK = await call(fullToken, rpcReq('tools/call', { name: 'recall', arguments: { query: 'cap test', k: 25 } }))
  check('recall k>20 does not error (clamps internally)', bigK.status === 200 && !bigK.json?.result?.isError)

  const truncFetch = await call(fullToken, rpcReq('tools/call', { name: 'fetch', arguments: { name: secretEntryName, max_chars: 60 } }))
  const truncText = truncFetch.json?.result?.content?.[0]?.text ?? ''
  check('fetch max_chars clamp respected', truncFetch.status === 200 && truncText.length <= 60 + 5, `len=${truncText.length}`)

  const overCapFetch = await call(fullToken, rpcReq('tools/call', { name: 'fetch', arguments: { name: secretEntryName, max_chars: 99999 } }))
  check('fetch max_chars over the hard cap -> tool error (not a crash)', overCapFetch.status === 200 && overCapFetch.json?.result?.isError === true)

  const briefFixture = await call(fullToken, rpcReq('tools/call', { name: 'brief', arguments: { project: projectName } }))
  const briefResult = JSON.parse(briefFixture.json?.result?.content?.[0]?.text ?? '{}')
  check('brief resolves the fixture project (not a no_match/ambiguous miss)', !briefResult.error, JSON.stringify(briefResult).slice(0, 150))
  check('brief fixture (a real projects row) resolves via projects_fk', briefResult.resolved_via === 'projects_fk', briefResult.resolved_via)
  const briefTotalLen = JSON.stringify(briefResult).length
  check('brief total size is within the ~16,000 char budget', briefTotalLen <= 16500, `len=${briefTotalLen}`)
  check('brief resume is truncated with an honest flag (fixture body is ~9KB > 8000 budget)', briefResult.truncated?.resume === true)
  check('brief open_items extracted from the resume', Array.isArray(briefResult.open_items) && briefResult.open_items.some((l) => /open|next/i.test(l)))
  check('brief docs includes the fixture document', Array.isArray(briefResult.docs) && briefResult.docs.length >= 1)
  check('brief activity includes the fixture activity row', Array.isArray(briefResult.activity) && briefResult.activity.length >= 1)

  const briefAmbiguousOrMiss = await call(fullToken, rpcReq('tools/call', { name: 'brief', arguments: { project: 'zzz-definitely-not-a-real-project-' + stamp } }))
  const briefMissResult = JSON.parse(briefAmbiguousOrMiss.json?.result?.content?.[0]?.text ?? '{}')
  check('brief on an unresolvable project -> structured no_match, not a crash', briefMissResult.error === 'no_match' && Array.isArray(briefMissResult.candidates))

  // ---- thread 0028 §1(b) acceptance additions: the memory_slug_fallback path against REAL prod data,
  //      independent of the synthetic fixture above. ADAPTIVE (2026-07-02 gate-run fix): the original
  //      hardcoded probes were wrong against real data — "Mnemosyne" has NO kind='project' entry in the
  //      brain at all (real data gap, queued for the thread-0028 (d) backfill unit), and "intellioptics"
  //      hit the fallback's EXACT-name-match arm (an entry named exactly `intellioptics` exists), which
  //      per the 0028 spec correctly WINS — exact match is never ambiguous. So: pick a real
  //      kind='project' entry from prod and probe with its own name (must resolve via fallback), and
  //      derive an ambiguous probe as a shared name prefix that exact-matches nothing. ----
  const { data: projEntries } = await admin.from('memory_entries').select('name').eq('kind', 'project').order('name')
  const projNames = (projEntries ?? []).map((r) => r.name)
  const realName = projNames[0]
  if (realName) {
    const briefRealFallback = await call(fullToken, rpcReq('tools/call', { name: 'brief', arguments: { project: realName } }))
    const briefRealResult = JSON.parse(briefRealFallback.json?.result?.content?.[0]?.text ?? '{}')
    check(`brief("${realName}") against real data resolves via memory_slug_fallback`, briefRealResult.resolved_via === 'memory_slug_fallback', JSON.stringify(briefRealResult).slice(0, 200))
    check('real-data fallback resume is non-null', typeof briefRealResult.resume === 'string' && briefRealResult.resume.length > 0)
  } else {
    check('brief real-data fallback (SKIPPED — no kind=project entries in brain)', true)
    check('real-data fallback resume (SKIPPED)', true)
  }

  // ambiguous probe: find a prefix shared by >1 project entry that is NOT itself an entry name (so the
  // exact-match arm can't win) and NOT a projects.name — must land in substring-candidates with >1.
  let ambigProbe = null
  for (const n of projNames) {
    for (let cut = n.length - 1; cut >= 4; cut--) {
      const prefix = n.slice(0, cut)
      const hits = projNames.filter((x) => x.includes(prefix))
      if (hits.length > 1 && !projNames.includes(prefix) && !prefix.startsWith('project-')) { ambigProbe = prefix; break }
    }
    if (ambigProbe) break
  }
  if (ambigProbe) {
    const briefAmbiguousSlug = await call(fullToken, rpcReq('tools/call', { name: 'brief', arguments: { project: ambigProbe } }))
    const briefAmbiguousResult = JSON.parse(briefAmbiguousSlug.json?.result?.content?.[0]?.text ?? '{}')
    check(`brief("${ambigProbe}") -> structured ambiguous error with candidates`, briefAmbiguousResult.error === 'ambiguous' && Array.isArray(briefAmbiguousResult.candidates) && briefAmbiguousResult.candidates.length > 1, JSON.stringify(briefAmbiguousResult).slice(0, 300))
  } else {
    check('brief ambiguous probe (SKIPPED — no shared prefix among real project entries)', true)
  }

  // ================= 4. REDACTION =================
  check('fetch redacts a secret in the fixture body', truncFetch.status !== 500) // establishes no crash; real check below at larger cap
  const fullFetch = await call(fullToken, rpcReq('tools/call', { name: 'fetch', arguments: { name: secretEntryName, max_chars: 16000 } }))
  const fullFetchText = fullFetch.json?.result?.content?.[0]?.text ?? ''
  check('fetch never leaks the raw secret', !fullFetchText.includes('sk_live_' + 'x'.repeat(10)))
  check('fetch shows the REDACTED marker', fullFetchText.includes('REDACTED-SECRET'))
  check('brief resume never leaks the raw secret (redacted BEFORE brief\'s own truncation)', !JSON.stringify(briefResult).includes('sk_live_' + 'x'.repeat(10)))

  // ================= 5. RATE LIMIT =================
  const bucketMachineId = await createMachine(`smoke-mcp-ratelimit-${stamp}`, ['brief'])
  const bucketTok = mintToken()
  await insertToken(bucketMachineId, bucketTok.hash, 'ratelimit')
  let saw429 = false, retryAfterHeader = null
  for (let i = 0; i < 12; i++) {
    const r = await call(bucketTok.token, rpcReq('tools/call', { name: 'brief', arguments: { project: projectName } }, i))
    if (r.status === 429) { saw429 = true; retryAfterHeader = r.headers.get('retry-after'); break }
  }
  check('burst past a tool bucket -> 429', saw429)
  check('429 carries a Retry-After header', !!retryAfterHeader, `retry-after=${retryAfterHeader}`)
  // bucket isolation: a DIFFERENT machine's brief calls are unaffected by machine A's burst
  const otherMachineDuringBurst = await call(fullToken, rpcReq('tools/call', { name: 'brief', arguments: { project: projectName } }))
  check('rate-limit buckets are per-machine, not global', otherMachineDuringBurst.status === 200)
  // thread 0029 item 5: this previously deleted rate_limits + team_members but NOT usage_events,
  // leaking orphaned smoke telemetry (usage_events.actor_id is ON DELETE SET NULL, so it wouldn't even
  // error — just silently orphan). cleanupMember covers usage_events/rate_limits/activity_log + the
  // FK-drop-safe team_members delete-then-deactivate fallback in one call.
  await admin.from('machine_tokens').delete().eq('member_id', bucketMachineId)
  await cleanupMember(admin, bucketMachineId)

  // ================= 6. TELEMETRY =================
  await new Promise((r) => setTimeout(r, 1500))
  const { data: usageRows } = await admin.from('usage_events').select('tool, source').eq('actor_id', fullMachineId)
  check('every mcp call logged a usage_events row with source=mcp', (usageRows ?? []).length > 0 && usageRows.every((r) => r.source === 'mcp'))
  check('usage_events tool names are prefixed mcp/', (usageRows ?? []).every((r) => r.tool.startsWith('mcp/')))

  // ================= 7. MACHINE ACTION ALLOWLIST =================
  const { count: beforeCount } = await admin.from('activity_log').select('id', { count: 'exact', head: true }).eq('actor_id', fullMachineId)
  const badAction = await call(fullToken, rpcReq('tools/call', { name: 'log_update', arguments: { action: 'secret.read' } }))
  check('machine log_update with disallowed action -> 403', badAction.status === 403)
  const { count: afterCount } = await admin.from('activity_log').select('id', { count: 'exact', head: true }).eq('actor_id', fullMachineId)
  check('disallowed action wrote NO row', beforeCount === afterCount, `before=${beforeCount} after=${afterCount}`)

  const linkedLogUpdate = await call(fullToken, rpcReq('tools/call', { name: 'log_update', arguments: { action: 'agent.note', detail: { project: projectName, note: 'linkage test' } } }))
  check('machine log_update with agent.note + resolvable project -> 200', linkedLogUpdate.status === 200 && !linkedLogUpdate.json?.result?.isError)
  const { data: linkedRow } = await admin.from('activity_log').select('entity_id').eq('actor_id', fullMachineId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  check('the forward-fix rider set entity_id from detail.project', linkedRow?.entity_id === projectId)

  // ================= 8. REVOCATION =================
  const beforeRevoke = await call(revokeToken, rpcReq('initialize', {}))
  check('revoke setup: token valid before revocation', beforeRevoke.status === 200)
  await admin.from('machine_tokens').update({ revoked_at: new Date().toISOString() }).eq('member_id', revokeMachineId).is('revoked_at', null)
  const afterRevoke = await call(revokeToken, rpcReq('initialize', {}))
  check('revoked mid-session -> next call 401', afterRevoke.status === 401)

  console.log(`\n[smoke-hosted-mcp] pass=${pass} fail=${fail}`)
  if (fail) process.exitCode = 1
}

main().catch((e) => { console.error('SMOKE ERROR:', e.stack || e.message); process.exitCode = 1 })
  .finally(() => cleanup())
