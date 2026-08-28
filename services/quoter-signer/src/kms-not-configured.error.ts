/** Allowlisted configuration-violation reasons carried by {@link KmsNotConfiguredError}. */
export type KmsConfigurationReason = 'missing' | 'invalid-identifier'

/**
 * Signals that the middleware's KMS maker-key deployment parameters are missing or invalid, so no
 * KMS call is attempted and every intent that reaches the signing stage is denied — the same
 * "refuse to serve" posture `PolicyNotConfiguredError` applies to the policy document
 * (TIB-2026-08-12: "Policy parameters missing/invalid at init → refuse to serve"). The message
 * carries only the violating deployment-variable name and an allowlisted reason — deployment
 * values never echo back to callers.
 */
export class KmsNotConfiguredError extends Error {
  readonly name = 'KmsNotConfiguredError'

  /** Terminal until the deployment is fixed: retrying against the same build cannot succeed. */
  readonly retryable = false

  /**
   * Creates a sanitized configuration rejection.
   * @param field - Deployment variable that is missing or invalid (for example
   * `QUOTER_SIGNER_KMS_KEY_ID`).
   * @param reason - Allowlisted constraint that failed.
   */
  constructor(
    readonly field: string,
    readonly reason: KmsConfigurationReason
  ) {
    super(`invalid quoter-signer kms configuration: ${field} ${reason}`)
  }
}
