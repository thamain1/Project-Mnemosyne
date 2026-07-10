// Hand-written type declarations for revert-core.mjs (Unit L, thread 0037).

export declare function validateRevertArgs(args: unknown): {
  name: string
  version_no: number
  change_reason: string
}

export declare function runRevert(
  args: unknown,
  deps: {
    embedDoc: (text: string) => Promise<string>
    rpc: (fn: string, args: any) => Promise<{ data: any; error: { message: string } | null }>
    actorId: string | null | undefined
  },
): Promise<string>
