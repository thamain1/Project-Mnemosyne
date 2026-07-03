// Hand-written type declarations for update-core.mjs (2026-07-04 ownership-parity unit) — see
// recall-core.d.mts for why.

export declare const MAX_CHANGE_REASON_LEN: number

export declare function validateUpdateArgs(args: unknown): {
  name: string
  title: string
  body: string
  kind: string
  change_reason?: string
  expected_updated_at: string
}

export declare function runUpdate(
  args: unknown,
  deps: {
    embedDoc: (text: string) => Promise<string>
    rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: { message: string } | null }>
    actorId: string | null | undefined
  },
): Promise<string>
