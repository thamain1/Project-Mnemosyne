// Hand-written type declarations for remember-core.mjs (thread 0033) — functions/api/mcp.ts and
// functions/_lib/client-brief.ts (typechecked, strict) import a few of its exports; declares only
// those, same minimal-but-accurate approach as recall-core.d.mts/fetch-core.d.mts/log-core.d.mts.

export declare const MAX_TITLE_LEN: number
export declare const MAX_BODY_LEN: number

export declare function isUuid(s: unknown): boolean

export declare function scanSecret(text: string): string | null

export declare function makeEmbedDoc(opts?: {
  apiKey: string
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
  timeoutMs?: number
  maxAttempts?: number
}): (text: string) => Promise<string>

export declare function runRemember(
  args: unknown,
  deps: {
    embedDoc: (text: string) => Promise<string>
    rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: { message: string } | null }>
    actorId: string | null | undefined
  },
): Promise<string>
