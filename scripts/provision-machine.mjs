#!/usr/bin/env node
// Mnemosyne — provision a machine identity + mint a hosted-MCP bearer token (thread 0027,
// P1-HOSTED-MCP). Idempotent on label (house standard: findFirst-then-create, never an
// "if count > 0 return" gate — see feedback_idempotent_seeds). The plaintext token is shown
// EXACTLY ONCE here; only its SHA-256 hash is ever stored.
//
// Run: node --env-file=.env.local scripts/provision-machine.mjs <label> [--scopes a,b,c] [--expires-days N]
// Reads: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from '@supabase/supabase-js'
import { randomBytes, randomUUID, createHash } from 'node:crypto'

const URL = process.env.VITE_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !SERVICE) { console.error('missing env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)'); process.exit(1) }

const ALL_SCOPES = ['recall', 'fetch', 'log_update', 'brief']
const DEFAULT_SCOPES = ['recall', 'log_update']   // minimal by default, per thread 0027's stated posture

function parseArgs(argv) {
  const label = argv[0]
  if (!label || label.startsWith('--')) {
    console.error('usage: node scripts/provision-machine.mjs <label> [--scopes recall,fetch,log_update,brief] [--expires-days N]')
    process.exit(1)
  }
  let scopes = DEFAULT_SCOPES
  let expiresDays
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--scopes' && argv[i + 1]) { scopes = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean); i++ }
    else if (argv[i] === '--expires-days' && argv[i + 1]) { expiresDays = Number(argv[i + 1]); i++ }
  }
  if (!scopes.length) { console.error('at least one scope is required'); process.exit(1) }
  for (const s of scopes) if (!ALL_SCOPES.includes(s)) { console.error(`unknown scope "${s}" — must be one of ${ALL_SCOPES.join(', ')}`); process.exit(1) }
  if (expiresDays !== undefined && (!Number.isFinite(expiresDays) || expiresDays <= 0)) { console.error('--expires-days must be a positive number'); process.exit(1) }
  return { label, scopes, expiresDays }
}

async function main() {
  const { label, scopes, expiresDays } = parseArgs(process.argv.slice(2))
  const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

  // idempotent on label: findFirst-then-create
  const { data: existing, error: findErr } = await admin
    .from('team_members').select('id').eq('kind', 'machine').eq('full_name', label).maybeSingle()
  if (findErr) throw new Error(`lookup failed: ${findErr.message}`)

  let memberId
  if (existing) {
    memberId = existing.id
    const { error: updErr } = await admin.from('team_members').update({ scopes, active: true }).eq('id', memberId)
    if (updErr) throw new Error(`update failed: ${updErr.message}`)
    console.log(`Machine "${label}" already exists (${memberId}) — scopes updated to [${scopes.join(', ')}].`)
  } else {
    memberId = randomUUID()   // team_members.id has no DB default (historically = auth.users.id); machine rows generate client-side
    const { error: insErr } = await admin.from('team_members').insert({ id: memberId, full_name: label, email: null, kind: 'machine', scopes, active: true })
    if (insErr) throw new Error(`insert failed: ${insErr.message}`)
    console.log(`Machine "${label}" created (${memberId}), scopes [${scopes.join(', ')}].`)
  }

  const token = 'mnk_' + randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const expires_at = expiresDays ? new Date(Date.now() + expiresDays * 86400_000).toISOString() : null

  const { error: tokErr } = await admin.from('machine_tokens').insert({ member_id: memberId, token_hash: tokenHash, label, expires_at })
  if (tokErr) throw new Error(`token insert failed: ${tokErr.message}`)

  console.log('\n=== TOKEN — copy it now, it is shown exactly once and never stored or displayed again ===')
  console.log(token)
  console.log('\n=== Add to a Claude Code / MCP client ===')
  console.log(`claude mcp add --transport http mnemosyne https://project-mnemosyne.pages.dev/api/mcp --header "Authorization: Bearer ${token}"`)
  console.log(`\nScopes: ${scopes.join(', ')}${expires_at ? `\nExpires: ${expires_at}` : '\nExpires: never (revoke manually if needed)'}`)
  console.log(`Revoke: node scripts/revoke-machine-token.mjs ${JSON.stringify(label)}`)
}

main().catch((e) => { console.error('PROVISION ERROR:', e.message); process.exit(1) })
