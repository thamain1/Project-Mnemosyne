// Mnemosyne — mnemosyne MCP usage-telemetry core (pure/injectable, testable keyless).
// Best-effort wrapper over the log_usage RPC (migration 0024, thread 0025 P5-TELEMETRY). Records
// bytes_in (args JSON length) / bytes_out (result text length) per tool call. Never throws — a
// telemetry failure must never surface to the caller or break a tool call.
// Env gate: MNEMOSYNE_TELEMETRY=1 default on; set to "0" to disable without a redeploy.

export const TELEMETRY_ON = process.env.MNEMOSYNE_TELEMETRY !== '0'

export async function logMcpUsage(rpc, { actorId, tool, bytesIn, bytesOut, ok }) {
  try {
    await rpc('log_usage', {
      p_actor: actorId || null,
      p_source: 'mcp',
      p_tool: tool,
      p_model: null,
      p_input_tokens: null,
      p_output_tokens: null,
      p_bytes_in: bytesIn,
      p_bytes_out: bytesOut,
      p_ok: ok,
    })
  } catch {
    // best-effort — telemetry failure must never surface to the caller
  }
}
