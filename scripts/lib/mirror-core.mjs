// Mnemosyne — memory-mirror core (pure/injectable, testable). No DB, no network, no stdout.
// Backs the one-way local→DB mirror of Claude Code memory files (TOKEN-GOVERNANCE-SYSTEM.md §16/§17/§18.1).
// G1 (sync metadata), G5 (secret isolation — reuses the single JS secret scanner), G7 (one-way: this
// module only ever READS local files and BUILDS upload payloads; it never writes local from DB).

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { scanSecret } from '../../mcp/lib/remember-core.mjs'   // one source of truth for G5 patterns

export const PROJECT_SLUG = 'claude-code-memory'

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

export function classify(sourcePath) {
  if (sourcePath === 'CLAUDE.md') return 'claude_md'
  if (basename(sourcePath).toUpperCase() === 'MEMORY.MD') return 'memory_index'
  return 'memory_topic_file'
}

// Discover the local files to mirror: every *.md under the memory dir + the global CLAUDE.md.
// source_path is the canonical, repo-relative key the mirror is stored under (UNIQUE in the table).
export function collectFiles({ memoryDir, claudeMd }) {
  const files = []
  if (memoryDir && existsSync(memoryDir)) {
    for (const f of readdirSync(memoryDir).sort()) {
      if (!f.toLowerCase().endsWith('.md')) continue
      const source_path = `memory/${f}`
      files.push({ abs: join(memoryDir, f), source_path, source_kind: classify(source_path) })
    }
  }
  if (claudeMd && existsSync(claudeMd)) {
    files.push({ abs: claudeMd, source_path: 'CLAUDE.md', source_kind: 'claude_md' })
  }
  return files
}

// Build one upsert payload from a file. Returns { payload, secret } — if `secret` is non-null the
// caller MUST refuse to push this file (G5 fail-closed); the DB RPC also rejects it as a backstop.
export function buildPayload(file) {
  const content = readFileSync(file.abs, 'utf8')
  const stat = statSync(file.abs)
  const secret = scanSecret(content)
  const payload = {
    source_path: file.source_path,
    source_kind: file.source_kind,
    project_slug: PROJECT_SLUG,
    content,
    content_hash: sha256(content),
    byte_size: Buffer.byteLength(content, 'utf8'),
    local_modified_at: stat.mtime.toISOString(),
    sync_status: 'current',
  }
  return { payload, secret }
}

// Compare a freshly-built payload against the row already in the mirror (by content_hash) to decide
// whether a push is needed — keeps the push idempotent (only changed files hit the DB).
export function isUnchanged(payload, existingRow) {
  return !!existingRow && existingRow.content_hash === payload.content_hash
}
