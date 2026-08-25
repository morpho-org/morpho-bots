/**
 * Signals that the `middleware` maker identity was asked for a generic in-process signer. That
 * request can never be served: TIB-2026-08-12 removes the blind digest-signing surface from the
 * bot on purpose, so middleware mode signs only through structured intent ports backed by the
 * quoter-signer Lambda — and this build does not implement those ports yet. Every write flow
 * fails closed with this error until they land; read-only operation is unaffected.
 */
export class MiddlewareSigningUnsupportedError extends Error {
  readonly name = 'MiddlewareSigningUnsupportedError'

  /** Creates the fixed fail-closed failure; middleware mode has no per-request detail to report. */
  constructor() {
    super(
      'middleware identity has no generic maker signer; quoter-signer intent ports are not implemented yet, so write flows fail closed'
    )
  }
}
