/**
 * The signing surfaces this build has not implemented — the only values
 * {@link SigningNotImplementedError} ever names, all middleware-chosen. `setup-remediation`
 * needs the remediation epochs and manifest-state reads, `self-cancel` the recorded-transaction
 * inventory, and `break-glass-revoke` the occupied-nonce inventory (cleanup must replace
 * occupied nonces, never queue at the pending one) — all later TIB-2026-08-12 increments.
 */
export type NotImplementedSurface = 'setup-remediation' | 'self-cancel' | 'break-glass-revoke'

/**
 * Signals that the requested operation's signing surface is a later TIB-2026-08-12 increment:
 * quote, ratify, and routine revocation sign in this build, while the named surface stays
 * fail-closed by design. Callers must treat the denial as deliberate middleware behavior for
 * that operation — not a transient fault, and not a build-wide inability to sign.
 */
export class SigningNotImplementedError extends Error {
  /** Terminal until a build implementing the surface is deployed: retrying cannot succeed. */
  readonly retryable = false

  /**
   * Creates the fail-closed denial scoped to the unimplemented surface.
   * @param surface - Middleware-chosen name of the surface this build does not implement.
   */
  constructor(readonly surface: NotImplementedSurface) {
    super(`${surface} signing is not implemented in this quoter-signer build; the intent is denied`)
    this.name = 'SigningNotImplementedError'
  }
}
