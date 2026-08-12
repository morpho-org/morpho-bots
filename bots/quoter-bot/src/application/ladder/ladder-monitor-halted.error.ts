import type { LadderMonitorReport } from './ladder-quoter.service'

/** Expected CLI failure emitted when continuous ladder monitoring halts before a shutdown signal. */
export class LadderMonitorHaltedError extends Error {
  readonly code = 'LADDER_MONITOR_HALTED'
  readonly kind = 'safety-halt'

  /**
   * Creates the stable, secret-free operator error.
   * @param report - Sanitized terminal monitor and cleanup report.
   */
  constructor(readonly report: LadderMonitorReport) {
    super('Ladder monitor halted for safety')
    this.name = 'LadderMonitorHaltedError'
  }
}
