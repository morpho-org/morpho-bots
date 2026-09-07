/**
 * The independent chain reads {@link RpcUnavailableError} may name — the TIB-2026-08-12
 * `middleware.read_failed` operations of this build. Both are read-only: a failed read produces no
 * signing side effect, so the denial is safely retryable.
 */
export type RpcReadOperation = 'chain-id' | 'pending-nonce'

/**
 * Signals that one of the middleware's own chain reads failed — network fault, provider error, or
 * a malformed response — so the intent fails closed with no KMS call (TIB-2026-08-12 failure
 * posture: an independent-read failure is a typed retryable denial, never a signature). The
 * message carries only the middleware-owned operation name; the endpoint URL and the provider's
 * response never reach responses or logs.
 */
export class RpcUnavailableError extends Error {
  readonly name = 'RpcUnavailableError'

  /** Transient by classification: the identical intent may succeed once the provider recovers. */
  readonly retryable = true

  /**
   * Creates a sanitized chain-read failure.
   * @param operation - Independent read whose call failed.
   * @param options - Standard error options; the unexpected provider fault may ride as `cause` for
   * middleware-side diagnostics. The cause never reaches responses or logs.
   */
  constructor(
    readonly operation: RpcReadOperation,
    options?: { readonly cause?: unknown }
  ) {
    super(`quoter-signer ${operation} read failed`, options)
  }
}
