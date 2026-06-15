#!/usr/bin/env node
// Project 4ward — "4ward-brain" MCP server (read path).
// Tool: recall(query, k) — embeds the query with gemini-embedding-001 (taskType RETRIEVAL_QUERY, 768,
// normalized), calls the read-only recall_memory RPC, returns top-k memories with provenance + freshness.
//
// CREDENTIAL MODEL (interim, single-operator, pre-auth): GEMINI_API_KEY + SUPABASE_SERVICE_ROLE_KEY.
// The only DB op this server performs is the READ-ONLY recall_memory RPC. Phase-2 target: per-user auth
// (recall_memory granted to `authenticated`; server uses the user's JWT; service-role removed from the
// read path). See docs/MCP-DESIGN.md. The MCP protocol speaks JSON-RPC over stdout — logs go to stderr.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createClient } from '@supabase/supabase-js'

const MODEL = 'gemini-embedding-001'
const DIMS = 768
const GEMINI_KEY = process.env.GEMINI_API_KEY
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!GEMINI_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing GEMINI_API_KEY / SUPABASE URL / SUPABASE_SERVICE_ROLE_KEY (see mcp/.env.example)')
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function embedQuery(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`
  const body = JSON.stringify({ content: { parts: [{ text }] }, taskType: 'RETRIEVAL_QUERY', outputDimensionality: DIMS })
  const MAX = 5
  for (let attempt = 1; attempt <= MAX; attempt++) {
    let res
    try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body }) }
    catch (e) { if (attempt < MAX) { await sleep(attempt * 1500); continue } throw e }
    if (res.ok) {
      const v = (await res.json())?.embedding?.values
      if (!Array.isArray(v) || v.length !== DIMS || !v.every(Number.isFinite)) throw new Error(`bad query embedding (len ${v?.length})`)
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
      return '[' + v.map((x) => x / n).join(',') + ']'
    }
    const t = await res.text()
    if ((res.status === 429 || res.status >= 500) && attempt < MAX) { await sleep(attempt * 1500); continue }
    throw new Error(`embed ${res.status}: ${t}`)
  }
  throw new Error('embed: exhausted retries')
}

const RECALL_TOOL = {
  name: 'recall',
  description: 'Semantic recall over the 4ward shared brain (memory entries + chunks). Returns the most relevant memories with name, title, similarity, source path, and last-updated freshness. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language query.' },
      k: { type: 'number', description: 'Max results, 1-50 (default 8).' },
    },
    required: ['query'],
  },
}

const server = new Server({ name: '4ward-brain', version: '0.1.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [RECALL_TOOL] }))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'recall') throw new Error(`unknown tool: ${req.params.name}`)
  const query = String(req.params.arguments?.query ?? '').trim()
  if (!query) return { isError: true, content: [{ type: 'text', text: 'recall: empty query' }] }
  const k = Math.min(Math.max(parseInt(req.params.arguments?.k ?? 8, 10) || 8, 1), 50)
  try {
    const qvec = await embedQuery(query)
    const { data, error } = await supabase.rpc('recall_memory', { query_embedding: qvec, match_count: k })
    if (error) return { isError: true, content: [{ type: 'text', text: `recall_memory error: ${error.message}` }] }
    if (!data?.length) return { content: [{ type: 'text', text: `No matches for: ${query}` }] }
    const lines = data.map((r, i) =>
      `${i + 1}. [${Number(r.similarity).toFixed(3)}] ${r.name} (${r.kind}) — ${r.title}\n   source: ${r.source_path} · updated: ${r.updated_at} · via: ${r.matched_via}`)
    return { content: [{ type: 'text', text: `Top ${data.length} for "${query}":\n\n${lines.join('\n')}` }] }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `recall failed: ${e.message}` }] }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[4ward-brain] MCP server connected — tool: recall')
