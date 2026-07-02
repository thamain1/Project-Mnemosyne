#!/usr/bin/env node
// Mnemosyne — thread 0030 acceptance check: proves the projects backfill actually fixed `brief()`
// against real prod data (not a fixture). Mints one throwaway machine token, calls the live hosted
// MCP endpoint, cleans up. Not part of the permanent smoke suite (real-data probes shouldn't be
// hardcoded into a CI-style suite — see thread 0027's adaptive-probe fix, 83b859b) but kept as a
// reusable one-off for future re-verification if the backfill is ever extended.
//
// Run: node --env-file=.env.local scripts/verify-projects-backfill.mjs

import { createClient } from '@supabase/supabase-js'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { cleanupMember } from './lib/cleanup-member.mjs'

const BASE = process.env.SMOKE_BASE || 'https://project-mnemosyne.pages.dev'
const URL = process.env.VITE_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !SERVICE) { console.error('missing env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)'); process.exit(1) }

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const stamp = String(Date.now())

let pass = 0, fail = 0
function check(name, ok, extra = '') { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

async function briefCall(token, project) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brief', arguments: { project } } }),
  })
  const json = await res.json().catch(() => null)
  const text = json?.result?.content?.[0]?.text
  return { status: res.status, isError: json?.result?.isError === true, result: text ? JSON.parse(text) : null }
}

let machineId
async function main() {
  machineId = randomUUID()
  const { error: insErr } = await admin.from('team_members').insert({ id: machineId, full_name: `verify-backfill-${stamp}`, email: null, kind: 'machine', scopes: ['brief'], active: true })
  if (insErr) throw new Error(`createMachine: ${insErr.message}`)
  const token = 'mnk_' + randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  const { error: tokErr } = await admin.from('machine_tokens').insert({ member_id: machineId, token_hash: hash, label: 'verify' })
  if (tokErr) throw new Error(`insertToken: ${tokErr.message}`)

  try {
    // ---- acceptance 1: the exact call that returned no_match on 2026-07-02 ----
    const mnemosyne = await briefCall(token, 'Mnemosyne')
    check('brief("Mnemosyne") -> 200, not a tool error', mnemosyne.status === 200 && !mnemosyne.isError, JSON.stringify(mnemosyne).slice(0, 200))
    check('brief("Mnemosyne") -> resolved_via=projects_fk', mnemosyne.result?.resolved_via === 'projects_fk', mnemosyne.result?.resolved_via)
    check('brief("Mnemosyne") -> non-null resume', typeof mnemosyne.result?.resume === 'string' && mnemosyne.result.resume.length > 0)
    check('brief("Mnemosyne") -> docs non-empty (the origin=rendered White Paper backfilled)', Array.isArray(mnemosyne.result?.docs) && mnemosyne.result.docs.length > 0, `docs=${JSON.stringify(mnemosyne.result?.docs)}`)

    // ---- acceptance 2: GIAV and Perks & Plays ----
    const giav = await briefCall(token, 'GIAV')
    check('brief("GIAV") -> resolved_via=projects_fk', giav.result?.resolved_via === 'projects_fk', giav.result?.resolved_via)
    check('brief("GIAV") -> non-null resume', typeof giav.result?.resume === 'string' && giav.result.resume.length > 0)
    check('brief("GIAV") -> docs non-empty (5 GIAV documents backfilled)', Array.isArray(giav.result?.docs) && giav.result.docs.length > 0, `docs=${giav.result?.docs?.length}`)

    const perks = await briefCall(token, 'Perks & Plays')
    check('brief("Perks & Plays") -> resolved_via=projects_fk', perks.result?.resolved_via === 'projects_fk', perks.result?.resolved_via)
    check('brief("Perks & Plays") -> non-null resume', typeof perks.result?.resume === 'string' && perks.result.resume.length > 0)

    // ---- acceptance 3: the fallback must still work for entries left unmapped by design ----
    const arsenaliq = await briefCall(token, 'arsenaliq')
    check('brief("arsenaliq") (unmapped, out of canonical scope) -> memory_slug_fallback still works', arsenaliq.result?.resolved_via === 'memory_slug_fallback', JSON.stringify(arsenaliq.result).slice(0, 150))
  } finally {
    await admin.from('machine_tokens').delete().eq('member_id', machineId)
    await cleanupMember(admin, machineId)
  }

  console.log(`\n[verify-projects-backfill] pass=${pass} fail=${fail}`)
  if (fail) process.exitCode = 1
}
main().catch((e) => { console.error('VERIFY ERROR:', e.stack || e.message); process.exitCode = 1 })
