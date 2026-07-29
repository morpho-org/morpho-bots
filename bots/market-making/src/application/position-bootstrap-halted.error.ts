/** Sanitized per-market bootstrap outcomes preserved for operator diagnostics. */
type PositionBootstrapHaltReport = readonly Record<string, unknown>[]

/** Expected CLI failure emitted when a bootstrap cycle enters a strategy-wide safety halt. */
export class PositionBootstrapHaltedError extends Error {
  readonly code = 'POSITION_BOOTSTRAP_HALTED'
  readonly kind = 'safety-halt'

  /** Creates the stable, secret-free operator error. @param report - Sanitized bootstrap outcomes. */
  constructor(readonly report: PositionBootstrapHaltReport) {
    super('Position bootstrap halted for safety')
    this.name = 'PositionBootstrapHaltedError'
  }
}
