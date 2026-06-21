#!/usr/bin/env node
// Mnemosyne — memory mirror RESTORE (DB→clean dir). TOKEN-GOVERNANCE-SYSTEM.md §18.1 G3.
// Rebuilds the mirrored memory files FROM the shared brain into a CLEAN target directory and verifies
// byte-fidelity (sha256). This is the G3 "restore is tested, not assumed" path and the way a remote
// machine pulls the brain down. It writes ONLY into the target dir — never the canonical local memory
// dir (G7 one-way: nothing here writes back over working files). Optionally hash-compares the rebuild
// against a local source dir to prove the round-trip is lossless.
//
// Run:
//   node --env-file=.env.local scripts/mirror-restore.mjs                      # -> ./mirror-restore-out
//   MIRROR_RESTORE_DIR=/path/out node --env-file=.env.local scripts/mirror-restore.mjs
//   node --env-file=.env.local scripts/mirror-restore.mjs --verify-against "C:/Users/.../.claude/projects/c--Dev/memory/.."
// Env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (service role reads all rows).

import { createClient } from '@supabase/supabase-js'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { sha256 } from './lib/mirror-core.mjs'

const URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const OUT = process.env.MIRROR_RESTORE_DIR || 'mirror-restore-out'
const args = process.argv.slice(2)
const verifyIdx = args.indexOf('--verify-against')
const VERIFY_DIR = verifyIdx >= 0 ? args[verifyIdx + 1] : null

if (!URL || !SERVICE) { console.error('missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
const db = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

const { data: rows, error } = await db
  .from('memory_mirror')
  .select('source_path, content, content_hash, byte_size, mirror_version, mirrored_at, sync_status')
  .order('source_path')
if (error) { console.error(`could not read memory_mirror: ${error.message}`); process.exit(1) }
if (!rows?.length) { console.error('memory_mirror is empty — nothing to restore'); process.exit(1) }

console.log(`Restoring ${rows.length} file(s) into ${OUT}/\n`)
let ok = 0, integrityFail = 0, verifyMatch = 0, verifyMismatch = 0, verifyMissing = 0

for (const r of rows) {
  // refuse path traversal defensively even though the RPC validated on write
  if (r.source_path.includes('..') || /^([/\\]|[A-Za-z]:)/.test(r.source_path)) {
    console.error(`SKIP (unsafe path)  ${r.source_path}`); integrityFail++; continue
  }
  const dest = join(OUT, r.source_path)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, r.content, 'utf8')

  // (a) integrity: does what we wrote match the hash the DB stored?
  const writtenHash = sha256(readFileSync(dest, 'utf8'))
  const integrityOk = writtenHash === r.content_hash
  if (!integrityOk) integrityFail++; else ok++

  // (b) optional fidelity vs. a live local source
  let vtag = ''
  if (VERIFY_DIR) {
    const src = join(VERIFY_DIR, r.source_path)
    if (!existsSync(src)) { vtag = '  [verify: MISSING locally]'; verifyMissing++ }
    else if (sha256(readFileSync(src, 'utf8')) === r.content_hash) { vtag = '  [verify: MATCH]'; verifyMatch++ }
    else { vtag = '  [verify: MISMATCH]'; verifyMismatch++ }
  }
  console.log(`${integrityOk ? 'ok ' : 'BAD'}  ${r.source_path}  v${r.mirror_version} ${r.byte_size}b${vtag}`)
}

console.log(`\nmirror-restore: wrote=${ok} integrity_fail=${integrityFail}`)
if (VERIFY_DIR) console.log(`verify vs ${VERIFY_DIR}: match=${verifyMatch} mismatch=${verifyMismatch} missing=${verifyMissing}`)
console.log(integrityFail || verifyMismatch ? '\nRESULT: FAIL — restore is NOT byte-faithful; do not trust the mirror yet.' : '\nRESULT: PASS — rebuild is byte-faithful.')
process.exit(integrityFail || verifyMismatch ? 1 : 0)
