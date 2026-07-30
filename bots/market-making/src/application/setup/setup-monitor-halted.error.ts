import type { SetupCheckMonitorReport } from './setup-check.service'

/** Expected terminal error carrying a sanitized halted setup-monitor report. */
export class SetupMonitorHaltedError extends Error {
  readonly name = 'SetupMonitorHaltedError'
  readonly code = 'SETUP_MONITOR_HALTED'
  readonly kind = 'monitor-halt'

  /**
   * Creates a setup-monitor halt from its operator-safe terminal report.
   * @param report - Halted lifecycle report with only an allowlisted error classification.
   */
  constructor(readonly report: SetupCheckMonitorReport & { status: 'halted' }) {
    super('Setup monitor halted')
  }
}
