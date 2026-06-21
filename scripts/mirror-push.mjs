#!/usr/bin/env node
// Mnemosyne — memory mirror PUSH (one-way local→DB, sanitize-on-push). TOKEN-GOVERNANCE §16/§17/§18/§19.
// Mirrors local Claude Code memory UP to the shared brain. LOCAL IS READ-ONLY here.
//   - {{SECRET …}}value{{/SECRET}} seals are vaulted via set_secret and replaced with get_secret pointers
//     (the plaintext value never leaves this machine).
//   - Backstop: after sanitizing, if any secret pattern REMAINS (an unsealed secret), the file is
//     BLOCKED, not pushed (fail closed). Credential files with a do-not-mirror marker are skipped.
//   - Idempotent: unchanged files (by sanitized content_hash) are not re-pushed.
//
// Run: node --env-file=.env.local --env-file=mcp/.env.local scripts/mirror-push.mjs
// Env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPERATOR_MEMBER_ID (admin, for set_secret).

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { collectFiles, sha256 } from './lib/mirror-core.mjs'
import { sanitize, isCredentialFile, isDenylisted } from './lib/mirror-sanitize.mjs'
import { scanSecret } from '../mcp/lib/remember-core.mjs'

const URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const ACTOR = process.env.OPERATOR_MEMBER_ID
const MEMORY_DIR = process.env.MIRROR_MEMORY_DIR || 'C:/Users/ThaMain1/.claude/projects/c--Dev/memory'
const CLAUDE_MD = process.env.MIRROR_CLAUDE_MD || 'C:/Users/ThaMain1/.claude/CLAUDE.md'
const DRY = !process.argv.includes('--apply')

if (!URL || !SERVICE) { console.error('missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
if (!ACTOR) { console.error('missing OPERATOR_MEMBER_ID (run with --env-file=mcp/.env.local too)'); process.exit(1) }

const db = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

async function vaultFn(value, attrs) {
  if (DRY) return 'DRY-RUN-ID'
  const meta = { service: attrs.service, sensitivity: attrs.sensitivity || 'restricted' }
  if (attrs.env) meta.environment = attrs.env
  if (attrs.scope) meta.scope = attrs.scope
  const { data, error } = await db.rpc('set_secret', { p_actor: ACTOR, p_meta: meta, p_secret: value })
  if (error) throw new Error(`set_secret(${attrs.service}): ${error.message}`)
  return data
}

const files = collectFiles({ memoryDir: MEMORY_DIR, claudeMd: CLAUDE_MD })
if (!files.length) { console.error(`no memory files under ${MEMORY_DIR}`); process.exit(1) }
console.log(`${DRY ? 'DRY RUN (no vaulting, no writes) — pass --apply to execute' : 'APPLY'} — ${files.length} file(s)\n`)

const { data: existingRows, error: listErr } = await db.from('memory_mirror').select('source_path, content_hash')
if (listErr) { console.error(`read memory_mirror: ${listErr.message}`); process.exit(1) }
const existing = new Map((existingRows || []).map((r) => [r.source_path, r]))

let pushed = 0, skipped = 0, blocked = 0, denied = 0, failed = 0, secretsVaulted = 0
const blockedFiles = []

for (const file of files) {
  let raw
  try { raw = readFileSync(file.abs, 'utf8') } catch (e) { console.error(`READ-FAIL ${file.source_path} — ${e.message}`); failed++; continue }

  if (isDenylisted(raw)) { console.log(`denylist  ${file.source_path}`); denied++; continue }

  // sanitize only if there are seals (avoids re-vaulting + touching files with no secrets)
  let sanitized = raw, vaulted = []
  if (raw.includes('{{SECRET')) {
    try { ({ sanitized, vaulted } = await sanitize(raw, { vaultFn })) }
    catch (e) { console.error(`VAULT-FAIL ${file.source_path} — ${e.message}`); failed++; continue }
  }

  // fail-closed backstop on the sanitized projection
  const reason = scanSecret(sanitized)
  if (reason) {
    const cred = isCredentialFile(file.source_path, raw) ? ' [credentials file]' : ''
    console.error(`BLOCKED   ${file.source_path} — unsealed secret (${reason})${cred}`)
    blockedFiles.push(file.source_path); blocked++; continue
  }

  const hash = sha256(sanitized)
  if (existing.get(file.source_path)?.content_hash === hash) { skipped++; continue }

  secretsVaulted += vaulted.length
  if (DRY) { console.log(`would push ${file.source_path}${vaulted.length ? ` (+${vaulted.length} vaulted)` : ''}`); pushed++; continue }

  const payload = {
    source_path: file.source_path, source_kind: file.source_kind, project_slug: 'claude-code-memory',
    content: sanitized, content_hash: hash, byte_size: Buffer.byteLength(sanitized, 'utf8'), sync_status: 'current',
  }
  const audit = { source_path: file.source_path, kind: file.source_kind, vaulted: vaulted.length }
  const { error } = await db.rpc('upsert_memory_mirror', { p_payload: payload, p_actor: ACTOR, p_audit: audit })
  if (error) { console.error(`RPC-FAIL  ${file.source_path} — ${error.message}`); failed++; continue }
  console.log(`pushed    ${file.source_path}${vaulted.length ? ` (+${vaulted.length} vaulted)` : ''}`)
  pushed++
}

console.log(`\nmirror-push: ${DRY ? 'would-push' : 'pushed'}=${pushed} unchanged=${skipped} blocked=${blocked} denylist=${denied} failed=${failed} secrets-vaulted=${secretsVaulted}`)
if (blocked) { console.error(`\n⚠ blocked (unsealed secret — seal with {{SECRET}} or mark do-not-mirror):`); blockedFiles.forEach((p) => console.error(`   - ${p}`)) }
process.exit(failed ? 1 : 0)
