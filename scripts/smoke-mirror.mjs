#!/usr/bin/env node
// Mnemosyne — memory-mirror live smoke (migration 0018). Proves the blocking guardrails:
//   1 upsert clean -> row created, hash stored, mirror_version=1            (round-trip)
//   2 re-push identical content -> mirror_version stays 1                   (idempotent)
//   3 push changed content -> mirror_version bumps to 2                     (versioning)
//   4 content with a secret -> RPC rejects, row unchanged                   (G5 server floor)
//   5 content_hash mismatch -> RPC rejects                                  (integrity)
//   6 non-member actor -> RPC rejects                                       (fail closed)
//   7 signed-in member direct INSERT/UPDATE/DELETE via Data API -> denied   (G7 / grant lockdown)
// Creates throwaway member + non-member and a probe row; cleans everything up.
//
// Run: node --env-file=.env.local scripts/smoke-mirror.mjs

import { createClient } from '@supabase/supabase-js'
import { sha256 } from './lib/mirror-core.mjs'

const URL = process.env.VITE_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !SERVICE || !PUB) { console.error('missing env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / publishable)'); process.exit(1) }

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const PW = 'Smoke!' + Math.abs(URL.length * 7919).toString(36) + 'xZ9'
const stamp = String(Date.now())
const memberEmail = `smoke-mirror-member-${stamp}@mnemosyne.test`
const nonmemberEmail = `smoke-mirror-nonmember-${stamp}@mnemosyne.test`
const PROBE = `memory/__smoke_mirror_${stamp}__.md`

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }
const mk = (content, over = {}) => ({ source_path: PROBE, source_kind: 'memory_topic_file', project_slug: 'claude-code-memory', content, content_hash: sha256(content), byte_size: Buffer.byteLength(content, 'utf8'), sync_status: 'current', ...over })
const row = async () => (await admin.from('memory_mirror').select('content_hash, mirror_version, content').eq('source_path', PROBE).maybeSingle()).data

let memberUid, nonmemberUid
async function setup() {
  const m = await admin.auth.admin.createUser({ email: memberEmail, password: PW, email_confirm: true })
  if (m.error) throw new Error('createUser member: ' + m.error.message)
  memberUid = m.data.user.id
  const ins = await admin.from('team_members').insert({ id: memberUid, full_name: 'Smoke Mirror Member', email: memberEmail, role: 'member', active: true })
  if (ins.error) throw new Error('insert team_members: ' + ins.error.message)
  const n = await admin.auth.admin.createUser({ email: nonmemberEmail, password: PW, email_confirm: true })
  if (n.error) throw new Error('createUser nonmember: ' + n.error.message)
  nonmemberUid = n.data.user.id
}
async function cleanup() {
  await admin.from('memory_mirror').delete().eq('source_path', PROBE)
  if (memberUid) { await admin.from('activity_log').delete().eq('actor_id', memberUid); await admin.from('team_members').delete().eq('id', memberUid); await admin.auth.admin.deleteUser(memberUid) }
  if (nonmemberUid) await admin.auth.admin.deleteUser(nonmemberUid)
}
async function signIn(email) {
  const c = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await c.auth.signInWithPassword({ email, password: PW })
  if (error) throw new Error('sign-in: ' + error.message)
  return c
}

try {
  await cleanup(); await setup()

  // 1 round-trip
  const r1 = await admin.rpc('upsert_memory_mirror', { p_payload: mk('# probe v1\nhello'), p_actor: memberUid, p_audit: { t: 1 } })
  const row1 = await row()
  check('1 upsert clean -> created', !r1.error && !!r1.data && row1?.mirror_version === 1 && row1?.content_hash === sha256('# probe v1\nhello'), r1.error?.message)

  // 2 idempotent (same content)
  await admin.rpc('upsert_memory_mirror', { p_payload: mk('# probe v1\nhello'), p_actor: memberUid, p_audit: { t: 2 } })
  check('2 re-push identical -> version stays 1', (await row())?.mirror_version === 1)

  // 3 changed content bumps version
  await admin.rpc('upsert_memory_mirror', { p_payload: mk('# probe v2\nchanged'), p_actor: memberUid, p_audit: { t: 3 } })
  check('3 changed content -> version 2', (await row())?.mirror_version === 2)

  // 4 G5 secret-block (valid hash so it reaches the secret check)
  const secretBody = '# leak\nSUPABASE_ACCESS_TOKEN=sbp_FAKETESTTOKENnotarealsecret0000'  // fixture: must match the secret regex to test rejection
  const r4 = await admin.rpc('upsert_memory_mirror', { p_payload: mk(secretBody), p_actor: memberUid, p_audit: { t: 4 } })
  const row4 = await row()
  check('4 secret content -> rejected + row unchanged', !!r4.error && row4?.mirror_version === 2 && row4?.content.includes('changed'), r4.error ? '' : 'NO ERROR returned!')

  // 5 hash mismatch
  const r5 = await admin.rpc('upsert_memory_mirror', { p_payload: mk('real', { content_hash: sha256('different') }), p_actor: memberUid, p_audit: { t: 5 } })
  check('5 hash mismatch -> rejected', !!r5.error, r5.error ? '' : 'NO ERROR returned!')

  // 6 non-member actor
  const r6 = await admin.rpc('upsert_memory_mirror', { p_payload: mk('# x'), p_actor: nonmemberUid, p_audit: { t: 6 } })
  check('6 non-member actor -> rejected', !!r6.error, r6.error ? '' : 'NO ERROR returned!')

  // 7 member direct Data-API writes denied
  const mc = await signIn(memberEmail)
  const di = await mc.from('memory_mirror').insert({ source_path: 'memory/hack.md', source_kind: 'other', content: 'x', content_hash: sha256('x'), byte_size: 1 }).select('id')
  const up = await mc.from('memory_mirror').update({ content: 'tampered' }).eq('source_path', PROBE).select('id')
  const de = await mc.from('memory_mirror').delete().eq('source_path', PROBE).select('id')
  const denied = (res) => !!res.error || !(res.data && res.data.length)
  check('7a member direct INSERT denied', denied(di), di.error?.code || '')
  check('7b member direct UPDATE denied', denied(up) && (await row())?.content.includes('changed'), up.error?.code || '')
  check('7c member direct DELETE denied', denied(de) && !!(await row()), de.error?.code || '')
  // member CAN read (RLS select policy)
  const sel = await mc.from('memory_mirror').select('source_path').eq('source_path', PROBE)
  check('7d member CAN read (RLS select)', !sel.error && sel.data?.length === 1, sel.error?.message)
} catch (e) {
  check('smoke harness', false, e.message)
} finally {
  await cleanup()
}

console.log(`\nsmoke-mirror: pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
