import type { MarketMakingMonitorReport } from './market-making.service'

/** Expected CLI failure carrying a sanitized halted combined-monitor report. */
export class MarketMakingMonitorHaltedError extends Error {
  readonly name = 'MarketMakingMonitorHaltedError'
  readonly code = 'MARKET_MAKING_MONITOR_HALTED'
  readonly kind = 'safety-halt'

  /**
   * Creates a combined monitor halt from its operator-safe terminal report.
   * @param report - Complete terminal outcomes for setup, bootstrap, and ladder monitoring.
   */
  constructor(readonly report: MarketMakingMonitorReport) {
    super('Market making monitor halted for safety')
  }
}
