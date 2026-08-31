/** Allowlisted configuration-violation reasons carried by {@link PolicyNotConfiguredError}. */
export type PolicyConfigurationReason =
  | 'missing'
  | 'not-json'
  | 'not-an-object'
  | 'unknown-key'
  | 'wrong-type'
  | 'unsupported-version'
  | 'invalid-address'
  | 'invalid-hex'
  | 'invalid-bytes32'
  | 'invalid-decimal'
  | 'invalid-identifier'
  | 'out-of-range'
  | 'empty'
  | 'duplicate'
  | 'mode-surface-mismatch'
  | 'incoherent-bounds'
  | 'insufficient-protected-ceiling'

/**
 * Signals that the middleware's deployment policy is missing or invalid, so the build refuses to
 * serve any intent — TIB-2026-08-12's "never run a partial or empty policy" posture. Raised when
 * parsing the `QUOTER_SIGNER_POLICY` deployment parameter fails; every invocation is then denied
 * with this typed cause. The message carries only the middleware-built field path and an
 * allowlisted reason — deployment values never echo back to callers.
 */
export class PolicyNotConfiguredError extends Error {
  readonly name = 'PolicyNotConfiguredError'

  /** Terminal until the deployment is fixed: retrying against the same build cannot succeed. */
  readonly retryable = false

  /**
   * Creates a sanitized configuration rejection.
   * @param field - Middleware-built path of the violating policy field (for example
   * `markets[0].maxTick`).
   * @param reason - Allowlisted constraint that failed.
   */
  constructor(
    readonly field: string,
    readonly reason: PolicyConfigurationReason
  ) {
    super(`invalid quoter-signer policy: ${field} ${reason}`)
  }
}
