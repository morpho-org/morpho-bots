/** The two KMS operations the middleware performs, named by {@link KmsUnavailableError}. */
export type KmsOperation = 'get-public-key' | 'sign'

/**
 * Signals that a KMS call itself failed — network fault, throttle, service error, or denied
 * access — so the middleware fails closed without a signature. Retryable by design: the failure
 * is on the AWS boundary, not in the intent, and TIB-2026-08-12 requires invocation-level faults
 * to halt-and-retry rather than degrade. For the `sign` operation the failure is a typed unknown,
 * never proof that no signature was produced server-side (TIB failure posture: "KMS error → typed
 * failure; never assume a signature was produced").
 */
export class KmsUnavailableError extends Error {
  readonly name = 'KmsUnavailableError'

  /** Transient by classification: the identical intent may succeed once KMS is reachable. */
  readonly retryable = true

  /**
   * Creates a sanitized KMS-boundary failure.
   * @param operation - KMS operation whose call failed.
   * @param options - Standard error options; the unexpected AWS SDK fault may ride as `cause` for
   * middleware-side diagnostics. The cause never reaches responses or logs — denial envelopes and
   * log lines carry only `name`, sanitized `message`, and `retryable`.
   */
  constructor(
    readonly operation: KmsOperation,
    options?: { readonly cause?: unknown }
  ) {
    super(`quoter-signer kms ${operation} call failed`, options)
  }
}
