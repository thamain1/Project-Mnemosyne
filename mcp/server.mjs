#!/usr/bin/env node
// Project 4ward — "4ward-brain" MCP server (read path). Thin wiring over lib/recall-core.mjs.
// Tool: recall(query, k) — strict args → embed query (gemini-embedding-001 RETRIEVAL_QUERY, 768,
// normalized, per-request timeout + bounded retries) → read-only recall_memory RPC → top-k with
// provenance + freshness.
//
// CREDENTIAL MODEL (interim, LOCAL single-operator only — never distribute the service-role key):
// GEMINI_API_KEY + SUPABASE_SERVICE_ROLE_KEY; only DB op is the read-only recall_memory RPC.
// Per-user/multi-operator access requires the Phase-2 auth path in docs/MCP-DESIGN.md (NOT this build).
// MCP speaks JSON-RPC over stdout — logs go to stderr only.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createClient } from '@supabase/supabase-js'
import { makeEmbedQuery, runRecall, MAX_K, MAX_QUERY_LEN, DEFAULT_K } from './lib/recall-core.mjs'

const GEMINI_KEY = process.env.GEMINI_API_KEY
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!GEMINI_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing GEMINI_API_KEY / SUPABASE URL / SUPABASE_SERVICE_ROLE_KEY (see mcp/.env.example)')
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
const embedQuery = makeEmbedQuery({ apiKey: GEMINI_KEY })
const rpc = (fn, args) => supabase.rpc(fn, args)

const RECALL_TOOL = {
  name: 'recall',
  description: 'Semantic recall over the 4ward shared brain (memory entries + chunks). Returns the most relevant memories with name, title, similarity, source path, and last-updated freshness. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: `Natural-language query (max ${MAX_QUERY_LEN} chars).` },
      k: { type: 'integer', minimum: 1, maximum: MAX_K, description: `Max results 1-${MAX_K} (default ${DEFAULT_K}).` },
    },
    required: ['query'],
  },
}

const server = new Server({ name: '4ward-brain', version: '0.1.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [RECALL_TOOL] }))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'recall') return { isError: true, content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }] }
  try {
    const text = await runRecall(req.params.arguments ?? {}, { embedQuery, rpc })
    return { content: [{ type: 'text', text }] }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `recall failed: ${e.message}` }] }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[4ward-brain] MCP server connected — tool: recall')
