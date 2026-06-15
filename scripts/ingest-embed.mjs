// Project 4ward — Phase 1 ingestion, EMBED phase (data-plane).
// Holds ONLY the Gemini key (never the Supabase service-role key — Aegis 0002-#2). Scans for secrets
// and quarantines (0002-#1), parses + chunks long entries (0002-#3), embeds via gemini-embedding-001
// @ 768 with the key in the x-goog-api-key header (0002-#4), normalizes vectors, and writes an
// intermediate artifact (.ingest/memory.jsonl) for the separate persist phase to load.
//
// Run:  node --env-file=.env.local scripts/ingest-embed.mjs [--dry-run] [--limit N] [--dir <path>]
//   --dry-run needs NO keys (scan/parse/chunk plan only). Live needs GEMINI_API_KEY only.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const MODEL = 'gemini-embedding-001'
const DIMS = 768
const ALLOWED_KINDS = new Set(['user', 'feedback', 'project', 'reference'])
const CHUNK_THRESHOLD = 8000  // chars; entries above this are chunked (Aegis: no silent truncation)
const CHUNK_SIZE = 6000
const CHUNK_OVERLAP = 500
const OUT_DIR = '.ingest'
const OUT_FILE = join(OUT_DIR, 'memory.jsonl')

// Secret detection — quarantine on any hit. Never log matched VALUES (0002-#1).
const SECRET_PATTERNS = [
  /sk_(live|test)_[A-Za-z0-9]{8,}/,                 // Stripe
  /\bsbp_[A-Za-z0-9]{20,}/,                          // Supabase management PAT
  /\bsb_(secret|publishable)_[A-Za-z0-9_]+/,         // Supabase new API keys
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/, // JWT
  /AIza[0-9A-Za-z_\-]{30,}/,                          // Google API key
  /\bAKIA[0-9A-Z]{16}\b/,                             // AWS access key id
  /\bghp_[A-Za-z0-9]{30,}/,                           // GitHub PAT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,              // private key block
  /xox[baprs]-[A-Za-z0-9-]{8,}/,                      // Slack
  /\b(api[_-]?key|secret|password|passwd|service_role|access_token|bearer)\b\s*[:=]\s*['"]?\S{8,}/i,
]
const DENY_FILENAME = /(secret|api[-_]?key|\bkeys?\b|cred|token|password)/i

function scanSecret(name, text) {
  if (DENY_FILENAME.test(name)) return 'filename matches secret pattern'
  for (const re of SECRET_PATTERNS) if (re.test(text)) return `content matches /${re.source.slice(0, 22)}…/`
  return null
}
const slugify = (f) => f.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function parseFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!m) return null
  const [, fm, body] = m
  return {
    description: fm.match(/^description:\s*(.+)$/m)?.[1]?.trim(),
    type: fm.match(/^\s*type:\s*([a-z_]+)\s*$/m)?.[1]?.trim(),
    body: body.trim(),
  }
}
function chunkBody(body) {
  if (body.length <= CHUNK_THRESHOLD) return [body]
  const out = []
  for (let i = 0; i < body.length; i += CHUNK_SIZE - CHUNK_OVERLAP) out.push(body.slice(i, i + CHUNK_SIZE))
  return out
}
const extractLinks = (b) => [...new Set([...b.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim()))]

// ---- args/env ----
const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const LIMIT = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : Infinity
const DIR = args.includes('--dir') ? args[args.indexOf('--dir') + 1]
  : process.env.MEMORY_DIR || 'C:\\Users\\ThaMain1\\.claude\\projects\\c--Dev\\memory'
const KEY = process.env.GEMINI_API_KEY
if (!DRY && !KEY) throw new Error('Missing GEMINI_API_KEY (or use --dry-run)')

async function embed(text) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({ content: { parts: [{ text }] }, taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: DIMS }),
  })
  if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`)
  const v = (await res.json())?.embedding?.values
  if (!Array.isArray(v) || v.length !== DIMS) throw new Error(`bad embedding length ${v?.length}`)
  // gemini-embedding-001 does NOT auto-normalize non-3072 dims; normalize for safe cosine/dot use.
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}
const vecLit = (v) => `[${v.join(',')}]`

// ---- main ----
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const files = (await readdir(DIR)).filter((f) => f.endsWith('.md') && f.toUpperCase() !== 'MEMORY.MD').slice(0, LIMIT)
console.log(`[embed] run=${runId} dir=${DIR} files=${files.length} dryRun=${DRY}`)
let embedded = 0, quarantined = 0, skipped = 0, chunksTotal = 0, failed = 0
const records = []

for (const file of files) {
  try {
    const raw = await readFile(join(DIR, file), 'utf8')
    const reason = scanSecret(file, raw)
    if (reason) { console.warn(`  QUARANTINE ${file} (${reason})`); quarantined++; continue }
    const fm = parseFrontmatter(raw)
    if (!fm || !ALLOWED_KINDS.has(fm.type)) { console.warn(`  SKIP ${file} (no/invalid frontmatter type — needs manual classification)`); skipped++; continue }

    const name = slugify(file)
    const title = fm.description || name
    const parts = chunkBody(fm.body)
    const rec = {
      name, kind: fm.type, title, body: fm.body, links: extractLinks(fm.body),
      source_path: `memory/${file}`, embedding_model: MODEL, chunked: parts.length > 1, run_id: runId, chunks: [],
    }

    if (DRY) { console.log(`  DRY ${file} -> ${name} kind=${fm.type} chunks=${parts.length} bodyLen=${fm.body.length}`); embedded++; chunksTotal += parts.length; continue }

    if (parts.length === 1) {
      rec.embedding = vecLit(await embed(`${title}\n\n${parts[0]}`))
    } else {
      rec.embedding = null // long entry: vectors live in chunks
      for (let i = 0; i < parts.length; i++) rec.chunks.push({ chunk_index: i, content: parts[i], embedding: vecLit(await embed(parts[i])), embedding_model: MODEL })
    }
    records.push(rec); embedded++; chunksTotal += parts.length
    console.log(`  OK ${file} -> ${name} (${parts.length} chunk(s))`)
  } catch (e) { console.error(`  FAIL ${file}: ${e.message}`); failed++ }
}

if (!DRY) {
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, records.map((r) => JSON.stringify(r)).join('\n'))
  console.log(`[embed] wrote ${records.length} records -> ${OUT_FILE}`)
}
console.log(`[embed] done run=${runId} embedded=${embedded} chunks=${chunksTotal} quarantined=${quarantined} skipped=${skipped} failed=${failed}`)
if (failed) process.exitCode = 1
