// Hand-written type declarations for fetch-core.mjs (thread 0027) — see recall-core.d.ts for why.

export declare const MAX_NAME_LEN: number
export declare const REDACTION: string
export declare const MAX_CHARS_CAP: number

export declare function redactSecrets(text: string | null | undefined): { text: string; count: number }
export declare function validateFetchArgs(args: unknown): { name: string; max_chars?: number }
export declare function truncateFormatted(text: string, maxChars?: number): { text: string; truncated: boolean }
export declare function formatEntry(row: Record<string, unknown> | null): string | null

export declare function runFetch(
  args: unknown,
  deps: { rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: { message: string } | null }> },
): Promise<string>
