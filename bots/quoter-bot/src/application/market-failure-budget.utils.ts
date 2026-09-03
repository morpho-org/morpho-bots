import type { Hex } from 'viem'

/**
 * Consecutive failing cycles tolerated for one market before monitoring halts.
 * @remarks `cycleRequiresHalt` in `@repo/monitoring` explains why a handled failure is retryable
 * and why it cannot promise the market is flat; this bounds how long stale quotes may stay live
 * before shutdown cleanup cancels them. Five cycles is roughly five minutes at a sixty-second loop.
 */
export const MARKET_FAILURE_BUDGET_CYCLES = 5

/**
 * Tracks consecutive handled failures per market across cycles of one monitor loop.
 * @param limit - Positive number of consecutive failing cycles tolerated for a single market.
 * @returns A predicate to call once per completed cycle, reporting whether any market exhausted its
 * budget. Markets absent from a cycle keep their running count; any other status clears it.
 */
export const createMarketFailureBudget = (limit: number) => {
  const consecutiveFailures = new Map<Hex, number>()

  return (results: readonly { marketId: Hex; status: string }[]) => {
    let exhausted = false
    for (const result of results) {
      const failures =
        result.status === 'failed' ? (consecutiveFailures.get(result.marketId) ?? 0) + 1 : 0
      consecutiveFailures.set(result.marketId, failures)
      if (failures >= limit) exhausted = true
    }
    return exhausted
  }
}
