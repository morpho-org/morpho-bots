import type { PositionBootstrapMonitorReport } from './position-bootstrap.service'

/** Expected CLI failure emitted when continuous position bootstrap halts before shutdown. */
export class PositionBootstrapMonitorHaltedError extends Error {
  readonly code = 'POSITION_BOOTSTRAP_MONITOR_HALTED'
  readonly kind = 'safety-halt'

  /**
   * Creates the stable, secret-free operator error.
   * @param report - Sanitized terminal monitor and cleanup report.
   */
  constructor(readonly report: PositionBootstrapMonitorReport) {
    super('Position bootstrap monitor halted for safety')
    this.name = 'PositionBootstrapMonitorHaltedError'
  }
}
