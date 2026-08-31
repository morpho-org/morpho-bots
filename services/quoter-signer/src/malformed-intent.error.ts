/** Allowlisted structural-violation reasons carried by {@link MalformedIntentError}. */
export type MalformedIntentReason =
  | 'not-an-object'
  | 'unknown-key'
  | 'missing'
  | 'wrong-type'
  | 'unsupported-version'
  | 'unsupported-kind'
  | 'invalid-address'
  | 'invalid-hex'
  | 'invalid-bytes32'
  | 'invalid-decimal'
  | 'invalid-identifier'
  | 'out-of-range'
  | 'empty'
  | 'too-many-offers'
  | 'too-many-markets'

/**
 * Signals that an invocation payload violates the versioned TIB-2026-08-12 wire contract, so the
 * middleware rejects it outright — no best-effort interpretation, no signing. The message carries
 * only the middleware-built field path and an allowlisted reason, never caller-supplied values.
 */
export class MalformedIntentError extends Error {
  readonly name = 'MalformedIntentError'

  /** Terminal for the payload as sent: retrying the identical intent can never succeed. */
  readonly retryable = false

  /**
   * Creates a sanitized structural rejection.
   * @param field - Middleware-built path of the violating field (for example `offers[3].maxAssets`).
   * @param reason - Allowlisted constraint that failed.
   */
  constructor(
    readonly field: string,
    readonly reason: MalformedIntentReason
  ) {
    super(`invalid quoter-signer intent: ${field} ${reason}`)
  }
}
