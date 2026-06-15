// Project 4ward — Phase 1 ingestion (unit 1): local memory files -> memory_entries (+ embeddings)
//
// Reads the second-brain memory files (MEMORY.md index excluded), parses frontmatter, embeds each
// entry with gemini-embedding-001 @ 768 dims, and upserts into public.memory_entries via the service
// role (bypasses RLS). The embedding model + source path are stored with every vector (0004).
//
// Run:  node --env-file=.env.local scripts/ingest-memory.mjs [--dry-run] [--limit N] [--dir <path>]
//   env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY
//
// NOTE: this is the representative Phase-1 unit for Aegis QC. Contracts/doc ingestion + the MCP server
// are separate units that follow after sign-off. Start with --dry-run, then --limit 2, then full.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const EMBEDDING_MODEL = 'gemini-embedding-001'
const EMBEDDING_DIMS = 768
const ALLOWED_KINDS = new Set(['user', 'feedback', 'project', 'reference'])
const MAX_EMBED_CHARS = 6000 // gemini-embedding-001 input cap ~2048 tokens; keep well under

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const limitIdx = args.indexOf('--limit')
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity
const dirIdx = args.indexOf('--dir')
const MEMORY_DIR =
  dirIdx !== -1 ? args[dirIdx + 1]
  : process.env.MEMORY_DIR || 'C:\\Users\\ThaMain1\\.claude\\projects\\c--Dev\\memory'

// ---- env ------------------------------------------------------------------
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const GEMINI_KEY = process.env.GEMINI_API_KEY
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
if (!GEMINI_KEY && !DRY_RUN) throw new Error('Missing GEMINI_API_KEY (add it to .env.local, or use --dry-run)')

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// ---- helpers --------------------------------------------------------------
function parseFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!m) return null
  const [, fm, body] = m
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  const type = fm.match(/^\s*type:\s*([a-z_]+)\s*$/m)?.[1]?.trim()
  return { name, description, type, body: body.trim() }
}

function extractLinks(body) {
  const out = new Set()
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) out.add(m[1].trim())
  return [...out]
}

async function embed(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_KEY}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // cosine index (vector_cosine_ops) is scale-invariant, so 768-dim non-normalized output is fine.
    body: JSON.stringify({
      content: { parts: [{ text: text.slice(0, MAX_EMBED_CHARS) }] },
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: EMBEDDING_DIMS,
    }),
  })
  if (!res.ok) throw new Error(`embed failed ${res.status}: ${await res.text()}`)
  const values = (await res.json())?.embedding?.values
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMS)
    throw new Error(`unexpected embedding length: ${values?.length}`)
  return `[${values.join(',')}]` // pgvector text literal
}

// ---- main -----------------------------------------------------------------
const files = (await readdir(MEMORY_DIR))
  .filter((f) => f.endsWith('.md') && f.toUpperCase() !== 'MEMORY.MD')
  .slice(0, LIMIT)

console.log(`[ingest-memory] dir=${MEMORY_DIR}  files=${files.length}  dryRun=${DRY_RUN}`)
let ok = 0, skipped = 0, failed = 0

for (const file of files) {
  const path = join(MEMORY_DIR, file)
  try {
    const raw = await readFile(path, 'utf8')
    const fm = parseFrontmatter(raw)
    if (!fm?.name) { console.warn(`  SKIP ${file} (no frontmatter name)`); skipped++; continue }
    if (!ALLOWED_KINDS.has(fm.type)) { console.warn(`  SKIP ${file} (kind="${fm.type}" not allowed)`); skipped++; continue }

    const title = fm.description || fm.name
    const row = {
      kind: fm.type,
      name: fm.name,
      title,
      body: fm.body,
      links: extractLinks(fm.body),
      source_path: path,
      embedding_model: EMBEDDING_MODEL,
    }

    if (DRY_RUN) { console.log(`  DRY ${file} -> kind=${row.kind} name=${row.name} links=${row.links.length}`); ok++; continue }

    row.embedding = await embed(`${title}\n\n${fm.body}`)
    const { error } = await supabase.from('memory_entries').upsert(row, { onConflict: 'name' })
    if (error) throw new Error(error.message)
    console.log(`  OK  ${file} -> ${row.name}`)
    ok++
  } catch (e) {
    console.error(`  FAIL ${file}: ${e.message}`)
    failed++
  }
}

console.log(`[ingest-memory] done. ok=${ok} skipped=${skipped} failed=${failed}`)
if (failed > 0) process.exitCode = 1
