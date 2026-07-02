// Hand-written type declarations for log-core.mjs (thread 0027) — see recall-core.d.ts for why.

export declare const ACTION_RE: RegExp
export declare const MAX_ACTION_LEN: number
export declare const MAX_ENTITY_TYPE_LEN: number
export declare const MAX_DETAIL_BYTES: number
export declare const MAX_DETAIL_KEYS: number
export declare const MAX_DETAIL_STR: number

export declare function scanObjectSecrets(obj: Record<string, unknown>): string | null
export declare function validateLogArgs(args: unknown): { action: string; entity_type: string | null; entity_id: string | null; detail: Record<string, unknown> }

export declare function runLogUpdate(
  args: unknown,
  deps: { rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: { message: string } | null }>; actorId: string | null | undefined },
): Promise<string>
