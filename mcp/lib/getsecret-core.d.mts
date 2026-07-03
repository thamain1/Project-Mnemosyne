// Hand-written type declarations for getsecret-core.mjs (2026-07-04 ownership-parity unit) — see
// recall-core.d.mts for why.

export declare function validateGetSecretArgs(args: unknown): { secret_id: string }

export declare function runGetSecret(
  args: unknown,
  deps: {
    rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: { message: string } | null }>
    actorId: string | null | undefined
  },
): Promise<string>
