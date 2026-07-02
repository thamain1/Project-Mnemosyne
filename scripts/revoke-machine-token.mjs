#!/usr/bin/env node
// Mnemosyne — revoke a machine's hosted-MCP tokens (thread 0027, P1-HOSTED-MCP incident runbook).
// One machine compromised → one token dead; the service-role master key is never touched. Revokes
// ALL active (non-expired, non-revoked) tokens for the label — a machine may have more than one.
//
// Run: node --env-file=.env.local scripts/revoke-machine-token.mjs <label> [--deactivate]
// --deactivate also flips the team_members row to active=false (full lockout, not just token kill —
// use when the machine itself, not just one token, needs to be retired).

import { createClient } from '@supabase/supabase-js'

const URL = process.env.VITE_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !SERVICE) { console.error('missing env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)'); process.exit(1) }

async function main() {
  const label = process.argv[2]
  const deactivate = process.argv.includes('--deactivate')
  if (!label || label.startsWith('--')) {
    console.error('usage: node scripts/revoke-machine-token.mjs <label> [--deactivate]')
    process.exit(1)
  }

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data: member, error: findErr } = await admin
    .from('team_members').select('id, active').eq('kind', 'machine').eq('full_name', label).maybeSingle()
  if (findErr) throw new Error(`lookup failed: ${findErr.message}`)
  if (!member) { console.error(`no machine found with label "${label}"`); process.exit(1) }

  const { data: revoked, error: revErr } = await admin
    .from('machine_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('member_id', member.id)
    .is('revoked_at', null)
    .select('id')
  if (revErr) throw new Error(`revoke failed: ${revErr.message}`)

  console.log(`Revoked ${revoked?.length ?? 0} active token(s) for "${label}".`)

  if (deactivate) {
    const { error: deactErr } = await admin.from('team_members').update({ active: false }).eq('id', member.id)
    if (deactErr) throw new Error(`deactivate failed: ${deactErr.message}`)
    console.log(`Machine "${label}" deactivated (team_members.active = false).`)
  }
}

main().catch((e) => { console.error('REVOKE ERROR:', e.message); process.exit(1) })
