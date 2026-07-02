// Mnemosyne — shared usage-telemetry helper (thread 0025, P5-TELEMETRY).
// Best-effort wrapper over the log_usage RPC (migration 0024). Never throws, never blocks or fails
// the parent request — telemetry is bookkeeping, not a dependency. Call AFTER the instrumented work
// completes (success or failure) so bytes_out / token counts are known.

import type { SupabaseClient } from '@supabase/supabase-js'

export type UsageEvent = {
  actorId: string | null
  tool: string
  // 'endpoint' (default) for the JWT /api/* surface; 'mcp' for the hosted MCP endpoint (thread 0029
  // build instruction #2 — local vs hosted is distinguished by actor, not by source spelling).
  source?: 'endpoint' | 'mcp'
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  bytesIn?: number | null
  bytesOut?: number | null
  ok?: boolean
}

export async function logUsage(admin: SupabaseClient, ev: UsageEvent): Promise<void> {
  try {
    await admin.rpc('log_usage', {
      p_actor: ev.actorId,
      p_source: ev.source ?? 'endpoint',
      p_tool: ev.tool,
      p_model: ev.model ?? null,
      p_input_tokens: ev.inputTokens ?? null,
      p_output_tokens: ev.outputTokens ?? null,
      p_bytes_in: ev.bytesIn ?? null,
      p_bytes_out: ev.bytesOut ?? null,
      p_ok: ev.ok ?? true,
    })
  } catch {
    // best-effort — telemetry failure must never surface to the caller
  }
}
