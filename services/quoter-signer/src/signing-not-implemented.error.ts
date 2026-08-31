/**
 * Signals that this quoter-signer build implements no signing surface: the maker-key custody
 * attestation holds `kms:GetPublicKey` only, the encode-and-sign stages of TIB-2026-08-12 are
 * later increments, and `kms:Sign` is never called — so every intent is denied even after passing
 * every implemented check. Callers must treat the denial as fail-closed middleware behavior
 * rather than a transient fault.
 */
export class SigningNotImplementedError extends Error {
  /** Terminal until a build with signing surfaces is deployed: retrying cannot succeed. */
  readonly retryable = false

  /** Creates the fixed fail-closed denial; this build has no per-intent detail to report. */
  constructor() {
    super('no signing surface is implemented in this quoter-signer build; every intent is denied')
    this.name = 'SigningNotImplementedError'
  }
}
