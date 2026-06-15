// Project 4ward — Phase 1 ingestion, PERSIST phase.
// Holds ONLY the Supabase service-role key (never the Gemini key — Aegis 0002-#2). Loads the
// .ingest/memory.jsonl artifact from the embed phase, rejects duplicate identities (0002-#5), upserts
// memory_entries + memory_chunks, and records an ingestion_runs row for audit (Aegis required).
//
// Run:  node --env-file=.env.local scripts/ingest-persist.mjs [--dry-run]

import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'

const IN_FILE = '.ingest/memory.jsonl'
const DRY = process.argv.slice(2).includes('--dry-run')

const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) throw new Error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
const supabase = createClient(URL, KEY, { auth: { persistSession: false } })

const records = (await readFile(IN_FILE, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
const runId = records[0]?.run_id || new Date().toISOString()
console.log(`[persist] run=${runId} records=${records.length} dryRun=${DRY}`)

// Reject duplicate canonical identities before any write (0002-#5).
const names = records.map((r) => r.name)
const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
if (dupes.length) throw new Error(`duplicate identities, aborting before writes: ${dupes.join(', ')}`)

let ok = 0, failed = 0, chunks = 0
if (!DRY) {
  for (const r of records) {
    try {
      const { error: e1 } = await supabase.from('memory_entries').upsert({
        name: r.name, kind: r.kind, title: r.title, body: r.body, links: r.links,
        source_path: r.source_path, embedding: r.embedding, embedding_model: r.embedding_model,
      }, { onConflict: 'name' })
      if (e1) throw new Error(e1.message)

      if (r.chunks?.length) {
        const { data, error: e2 } = await supabase.from('memory_entries').select('id').eq('name', r.name).single()
        if (e2) throw new Error(e2.message)
        await supabase.from('memory_chunks').delete().eq('memory_entry_id', data.id) // replace on re-run
        const rows = r.chunks.map((c) => ({ memory_entry_id: data.id, chunk_index: c.chunk_index, content: c.content, embedding: c.embedding, embedding_model: c.embedding_model }))
        const { error: e3 } = await supabase.from('memory_chunks').insert(rows)
        if (e3) throw new Error(e3.message)
        chunks += rows.length
      }
      ok++
    } catch (e) { console.error(`  FAIL ${r.name}: ${e.message}`); failed++ }
  }
  const { error: eRun } = await supabase.from('ingestion_runs').insert({
    kind: 'memory', status: failed ? 'partial' : 'success',
    counts: { records: records.length, ok, failed, chunks }, notes: `run ${runId}`,
  })
  if (eRun) console.warn(`  (run-record insert failed: ${eRun.message})`)
}
console.log(`[persist] done ok=${ok} failed=${failed} chunks=${chunks}`)
if (failed) process.exitCode = 1
