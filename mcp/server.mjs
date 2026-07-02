#!/usr/bin/env node
// Mnemosyne — "mnemosyne" MCP server (read path). Thin wiring over lib/recall-core.mjs.
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
import { makeEmbedDoc, runRemember, MAX_TITLE_LEN, MAX_BODY_LEN, MAX_NAME_LEN } from './lib/remember-core.mjs'
import { runLogUpdate, MAX_ACTION_LEN } from './lib/log-core.mjs'
import { runGetSecret } from './lib/getsecret-core.mjs'
import { runFetch } from './lib/fetch-core.mjs'
import { runUpdate, MAX_CHANGE_REASON_LEN } from './lib/update-core.mjs'
import { logMcpUsage, TELEMETRY_ON } from './lib/usage-core.mjs'

const GEMINI_KEY = process.env.GEMINI_API_KEY
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!GEMINI_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing GEMINI_API_KEY / SUPABASE URL / SUPABASE_SERVICE_ROLE_KEY (see mcp/.env.example)')
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
const embedQuery = makeEmbedQuery({ apiKey: GEMINI_KEY })
const embedDoc = makeEmbedDoc({ apiKey: GEMINI_KEY })
const rpc = (fn, args) => supabase.rpc(fn, args)
// Operator identity for WRITE tools (remember/log_update): a server-configured ACTIVE team_members.id.
// The write cores fail closed if it's absent/invalid. Not needed for the read-only recall path.
const OPERATOR_ID = process.env.OPERATOR_MEMBER_ID

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

// READ tool — read the FULL body of one entry by name (the counterpart to metadata-only recall). recall
// finds the name; fetch reads the contents, so an agent can faithfully fold an entry's detail into a
// revision instead of blind-overwriting it. Read-only; no operator actor required.
const FETCH_TOOL = {
  name: 'fetch',
  description: 'Read the full stored content of one memory entry by its name (slug). Use after recall to read what an entry actually says — its body, classification, provenance, links, and freshness. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', maxLength: MAX_NAME_LEN, description: 'The entry slug (e.g. from a recall result, like "intellioptics-2-5"). Sloppy names are normalized.' },
      max_chars: { type: 'integer', minimum: 1, maximum: 16000, description: 'Optional cap on the returned text length (redaction always runs first). Omit for the full body.' },
    },
    required: ['name'],
  },
}

// WRITE tool — interim LOCAL single-operator only (server holds the service-role key). Embeds via Google,
// so remember-core secret-scans + refuses secret-bearing content (incident 0006). Writes via the hardened
// service-role-only ingest_memory_entry RPC.
const REMEMBER_TOOL = {
  name: 'remember',
  description: 'Write a new memory into the 4ward shared brain. Embeds + stores the title/body under a slug derived from the title (or an explicit name). Refuses content containing secrets. Read-then-write; not for secrets.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', maxLength: MAX_TITLE_LEN, description: 'Short title; also used as the entry summary.' },
      body: { type: 'string', maxLength: MAX_BODY_LEN, description: 'The memory content (markdown). [[links]] are captured.' },
      kind: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'Memory category.' },
      name: { type: 'string', description: 'Optional explicit slug; defaults to the slugified title.' },
    },
    required: ['title', 'body', 'kind'],
  },
}

// WRITE tool — revise an EXISTING entry (canonical memory/ OR operator mcp/). Unlike remember (own mcp/
// namespace only), update can revise a file-backed canonical entry — but every update is versioned +
// reversible (prior state → memory_versions) and provenance is immutable. Optimistic concurrency:
// pass expected_updated_at (from fetch) so a stale revision is rejected, not silently clobbered. Embeds
// via Google → secret-scans + refuses secrets. Interim LOCAL single-operator only.
const UPDATE_TOOL = {
  name: 'update',
  description: 'Revise an EXISTING memory entry by name. Read it with fetch first, fold in the detail, then update — prior content is saved as a reversible version. Pass expected_updated_at (from fetch) for safe concurrent edits. Refuses secrets. Does not create entries (use remember for new ones).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', maxLength: MAX_NAME_LEN, description: 'Slug of the existing entry to revise.' },
      title: { type: 'string', maxLength: MAX_TITLE_LEN, description: 'New title / summary.' },
      body: { type: 'string', maxLength: MAX_BODY_LEN, description: 'New full content (markdown). [[links]] are captured.' },
      kind: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'Memory category.' },
      change_reason: { type: 'string', maxLength: MAX_CHANGE_REASON_LEN, description: 'Note on what changed (stored in history + audit). REQUIRED when revising a canonical memory/ entry.' },
      expected_updated_at: { type: 'string', description: 'REQUIRED ISO timestamp the entry showed when you fetched it; the update is rejected if the entry changed since (optimistic concurrency — forces read-before-write).' },
    },
    required: ['name', 'title', 'body', 'kind', 'expected_updated_at'],
  },
}

// APPEND tool — writes activity_log via the hardened service-role-only log_activity RPC (0009).
const LOG_UPDATE_TOOL = {
  name: 'log_update',
  description: 'Append a who-did-what entry to the 4ward activity log. action is a namespaced token (e.g. "work.note", "deal.update"); narrative + safe metadata go in detail. Append-only; refuses secrets.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', maxLength: MAX_ACTION_LEN, description: 'Namespaced action, e.g. "work.note" (^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$).' },
      entity_type: { type: 'string', description: 'Optional subject type (e.g. "project", "deal").' },
      entity_id: { type: 'string', description: 'Optional subject uuid.' },
      detail: { type: 'object', description: 'Optional flat JSON object of safe metadata (≤4KB, no nesting, no secrets).' },
    },
    required: ['action'],
  },
}

// SECRET tool — interim LOCAL single-operator only. Reads a decrypted value via the audited,
// sensitivity-gated get_secret_operator RPC (migration 0010). The value travels only in the tool result;
// it is NEVER logged. Not for teammate distribution (per Aegis 0009).
const GET_SECRET_TOOL = {
  name: 'get_secret',
  description: 'Retrieve a stored credential from the 4ward secrets vault by its id. Sensitivity-gated (admin/restricted require an admin operator) and audited. Returns the decrypted value to the local operator only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      secret_id: { type: 'string', description: 'The secrets_vault row id (uuid) to retrieve.' },
    },
    required: ['secret_id'],
  },
}

const HANDLERS = {
  recall: (args) => runRecall(args, { embedQuery, rpc }),
  fetch: (args) => runFetch(args, { rpc }),
  remember: (args) => runRemember(args, { embedDoc, rpc, actorId: OPERATOR_ID }),
  update: (args) => runUpdate(args, { embedDoc, rpc, actorId: OPERATOR_ID }),
  log_update: (args) => runLogUpdate(args, { rpc, actorId: OPERATOR_ID }),
  get_secret: (args) => runGetSecret(args, { rpc, actorId: OPERATOR_ID }),
}

const server = new Server({ name: 'mnemosyne', version: '0.1.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [RECALL_TOOL, FETCH_TOOL, REMEMBER_TOOL, UPDATE_TOOL, LOG_UPDATE_TOOL, GET_SECRET_TOOL] }))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = HANDLERS[req.params.name]
  if (!handler) return { isError: true, content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }] }
  const args = req.params.arguments ?? {}
  const bytesIn = Buffer.byteLength(JSON.stringify(args), 'utf8')
  try {
    const text = await handler(args)
    if (TELEMETRY_ON) await logMcpUsage(rpc, { actorId: OPERATOR_ID, tool: req.params.name, bytesIn, bytesOut: Buffer.byteLength(text, 'utf8'), ok: true })
    return { content: [{ type: 'text', text }] }
  } catch (e) {
    if (TELEMETRY_ON) await logMcpUsage(rpc, { actorId: OPERATOR_ID, tool: req.params.name, bytesIn, bytesOut: 0, ok: false })
    return { isError: true, content: [{ type: 'text', text: `${req.params.name} failed: ${e.message}` }] }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[mnemosyne] MCP server connected — tools: recall, fetch, remember, update, log_update, get_secret')
