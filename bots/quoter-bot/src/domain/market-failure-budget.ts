/**
 * Consecutive failing cycles tolerated for one market before monitoring halts.
 * @remarks A handled failure is retried, but it can leave the previous offers live, so this bounds
 * how long stale quotes may stay up before shutdown cleanup cancels them. Five cycles is roughly
 * five minutes at a sixty-second loop.
 */
export const MARKET_FAILURE_BUDGET_CYCLES = 5

/** Each market's consecutive failing cycles, by market ID. */
export type FailureCounts = Readonly<Record<string, number>>

/**
 * Counts one completed cycle into each market's run of consecutive handled failures. Markets absent
 * from the cycle keep their running count; any other status clears it, unless the market is listed
 * as unresolved.
 * @param counts - Each market's consecutive failures before this cycle.
 * @param results - Each polled market's status this cycle.
 * @param unresolved - Markets whose last failed act is still unresolved; they count as failing.
 * @returns The next counts.
 */
export const countFailures = (
  counts: FailureCounts,
  results: readonly { marketId: string; status: string }[],
  unresolved: ReadonlySet<string> = new Set()
): FailureCounts => {
  const next = { ...counts }
  for (const { marketId, status } of results)
    next[marketId] = status === 'failed' || unresolved.has(marketId) ? (next[marketId] ?? 0) + 1 : 0
  return next
}

/**
 * Whether any market's run of failures reached `limit`.
 * @param counts - Each market's consecutive failing cycles.
 * @param limit - Failing cycles that exhaust the budget.
 * @returns `true` once any market's count is at least `limit`.
 */
export const exhausted = (counts: FailureCounts, limit: number) =>
  Object.values(counts).some(failures => failures >= limit)
