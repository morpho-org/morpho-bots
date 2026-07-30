/** Sanitized per-market ladder outcomes preserved for operator diagnostics. */
type LadderCycleHaltReport = readonly Record<string, unknown>[]

/** Expected CLI failure emitted when a ladder cycle fails or enters a safety halt. */
export class LadderCycleHaltedError extends Error {
  readonly code = 'LADDER_CYCLE_HALTED'
  readonly kind = 'safety-halt'

  /** Creates the stable, secret-free operator error. @param report - Sanitized ladder outcomes. */
  constructor(readonly report: LadderCycleHaltReport) {
    super('Ladder cycle halted for safety')
    this.name = 'LadderCycleHaltedError'
  }
}
