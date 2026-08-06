import type { QuoterBotMonitorReport } from './quoter-bot.service'

/** Expected CLI failure carrying a sanitized halted combined-monitor report. */
export class QuoterBotMonitorHaltedError extends Error {
  readonly name = 'QuoterBotMonitorHaltedError'
  readonly code = 'QUOTER_BOT_MONITOR_HALTED'
  readonly kind = 'safety-halt'

  /**
   * Creates a combined monitor halt from its operator-safe terminal report.
   * @param report - Complete terminal outcomes for setup, bootstrap, and ladder monitoring.
   */
  constructor(readonly report: QuoterBotMonitorReport) {
    super('Quoter bot monitor halted for safety')
  }
}
