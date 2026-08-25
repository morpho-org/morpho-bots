/**
 * Signals that this quoter-signer build implements no signing surface: the delivery skeleton of
 * TIB-2026-08-12 holds no KMS access and denies every intent, so callers must treat the denial as
 * fail-closed middleware behavior rather than a transient fault.
 */
export class SigningNotImplementedError extends Error {
  /** Terminal until a build with signing surfaces is deployed: retrying cannot succeed. */
  readonly retryable = false

  /** Creates the fixed fail-closed denial; the skeleton has no per-intent detail to report. */
  constructor() {
    super('no signing surface is implemented in this quoter-signer build; every intent is denied')
    this.name = 'SigningNotImplementedError'
  }
}
