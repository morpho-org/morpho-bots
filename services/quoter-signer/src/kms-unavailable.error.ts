/**
 * The read-only KMS operations {@link KmsUnavailableError} may name. Deliberately excludes
 * `sign`: a failed `Sign` call has an ambiguous outcome and maps to the non-retryable
 * `KmsSignOutcomeUnknownError` instead, because advertising invocation-level retry there could
 * mint a second signature and CloudTrail `Sign` event for one artifact.
 */
export type KmsOperation = 'get-public-key'

/**
 * Signals that a read-only KMS call failed — network fault, throttle, service error, or denied
 * access — so the middleware fails closed without a signature. Retryable by design: the failure
 * is on the AWS boundary, not in the intent, the operation produces no signing side effect, and
 * TIB-2026-08-12 requires invocation-level faults to halt-and-retry rather than degrade.
 */
export class KmsUnavailableError extends Error {
  readonly name = 'KmsUnavailableError'

  /** Transient by classification: the identical intent may succeed once KMS is reachable. */
  readonly retryable = true

  /**
   * Creates a sanitized KMS-boundary failure.
   * @param operation - Read-only KMS operation whose call failed.
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
