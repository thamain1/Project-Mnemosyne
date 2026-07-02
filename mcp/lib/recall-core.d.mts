// Hand-written type declarations for recall-core.mjs (thread 0027) — this repo's local MCP tools are
// plain JS with no build step; functions/api/mcp.ts (typechecked, strict) imports the same core, so it
// needs explicit types rather than relying on tsc's best-effort JS inference (which drops parameters
// that have no default value in a destructured signature, e.g. `apiKey` below).

export declare const MODEL: string
export declare const DIMS: number
export declare const MAX_QUERY_LEN: number
export declare const MAX_K: number
export declare const DEFAULT_K: number

export declare function validateArgs(args: unknown): { query: string; k: number }
export declare function toVecLiteral(values: number[]): string

export declare function makeEmbedQuery(opts: {
  apiKey: string
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
  timeoutMs?: number
  maxAttempts?: number
}): (text: string) => Promise<string>

export declare function formatResults(query: string, rows: unknown[]): string

export declare function runRecall(
  args: unknown,
  deps: { embedQuery: (text: string) => Promise<string>; rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: { message: string } | null }> },
): Promise<string>
