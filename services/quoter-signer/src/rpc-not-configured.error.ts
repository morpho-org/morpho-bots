/** Allowlisted configuration-violation reasons carried by {@link RpcNotConfiguredError}. */
export type RpcConfigurationReason = 'missing' | 'invalid-url'

/**
 * Signals that the middleware's RPC endpoint deployment parameter is missing or invalid, so every
 * transaction-signing intent is denied — the maker's pending nonce comes from the middleware's own
 * independent read (TIB-2026-08-12), and without a usable endpoint that read cannot happen.
 * Quote intents sign no maker transaction and are unaffected. The message carries only the
 * middleware-built field name and an allowlisted reason — the configured URL never echoes back to
 * callers, per the repository rule that operator-visible errors exclude URLs.
 */
export class RpcNotConfiguredError extends Error {
  readonly name = 'RpcNotConfiguredError'

  /** Terminal until the deployment is fixed: retrying against the same build cannot succeed. */
  readonly retryable = false

  /**
   * Creates a sanitized configuration rejection.
   * @param field - Middleware-built name of the violating deployment parameter.
   * @param reason - Allowlisted constraint that failed.
   */
  constructor(
    readonly field: string,
    readonly reason: RpcConfigurationReason
  ) {
    super(`invalid quoter-signer rpc configuration: ${field} ${reason}`)
  }
}
