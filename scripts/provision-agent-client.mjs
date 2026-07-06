#!/usr/bin/env node
// Mnemosyne — provision an agent_clients row + mint an Agent API bearer token
// (docs/WORK-ORDER-AGENT-API.md, migration 0031). Idempotent on client_slug (house standard:
// findFirst-then-create). The plaintext token is shown EXACTLY ONCE here; only its SHA-256 hash is
// ever stored. This is a cross-system credential (consumed by an external agent system, e.g.
// IntelliService-ISB) — hand it off out-of-band per the Sealed Credential standard, never paste it
// into a chat/agent session or commit it anywhere.
//
// Run: node --env-file=.env.local scripts/provision-agent-client.mjs <client_slug> "<Display Name>" [--notes "..."]
// Reads: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from '@supabase/supabase-js'
import { randomBytes, createHash } from 'node:crypto'

const URL = process.env.VITE_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !SERVICE) { console.error('missing env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)'); process.exit(1) }

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function parseArgs(argv) {
  const clientSlug = argv[0]
  const displayName = argv[1]
  if (!clientSlug || !SLUG_RE.test(clientSlug) || !displayName || displayName.startsWith('--')) {
    console.error('usage: node scripts/provision-agent-client.mjs <client_slug> "<Display Name>" [--notes "..."]')
    process.exit(1)
  }
  let notes = null
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--notes' && argv[i + 1]) { notes = argv[i + 1]; i++ }
  }
  return { clientSlug, displayName, notes }
}

async function main() {
  const { clientSlug, displayName, notes } = parseArgs(process.argv.slice(2))
  const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data: existing, error: findErr } = await admin
    .from('agent_clients').select('client_slug').eq('client_slug', clientSlug).maybeSingle()
  if (findErr) throw new Error(`lookup failed: ${findErr.message}`)

  const token = 'agt_' + randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')

  if (existing) {
    const { error: updErr } = await admin.from('agent_clients')
      .update({ display_name: displayName, token_hash: tokenHash, is_active: true, notes })
      .eq('client_slug', clientSlug)
    if (updErr) throw new Error(`update failed: ${updErr.message}`)
    console.log(`Agent client "${clientSlug}" already existed — token ROTATED, display_name/notes updated.`)
  } else {
    const { error: insErr } = await admin.from('agent_clients')
      .insert({ client_slug: clientSlug, display_name: displayName, token_hash: tokenHash, is_active: true, notes })
    if (insErr) throw new Error(`insert failed: ${insErr.message}`)
    console.log(`Agent client "${clientSlug}" created.`)
  }

  console.log('\n=== TOKEN — copy it now, it is shown exactly once and never stored or displayed again ===')
  console.log(token)
  console.log('\n=== Handoff (Sealed Credential standard — cross-system secret, out-of-band ONLY) ===')
  console.log(`Deliver this token to the consuming system's operator directly (not chat, not a commit).`)
  console.log(`Endpoints: POST https://project-mnemosyne.pages.dev/api/agent-context`)
  console.log(`           POST https://project-mnemosyne.pages.dev/api/agent-outcome`)
  console.log(`Both take "Authorization: Bearer ${token.slice(0, 8)}..." (full token above).`)
  console.log(`\nDeactivate: update agent_clients set is_active = false where client_slug = '${clientSlug}';`)
}

main().catch((e) => { console.error('PROVISION ERROR:', e.message); process.exit(1) })
