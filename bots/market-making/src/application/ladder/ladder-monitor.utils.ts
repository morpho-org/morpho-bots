/**
 * Detects whether a completed ladder cycle entered a handled failure or safety halt.
 * @param results - Ordered sanitized market outcomes from one complete cycle.
 * @returns Whether monitoring must stop before another cycle begins.
 */
export const ladderCycleHasFailure = (results: readonly { status: string }[]) =>
  results.some(result => result.status === 'failed' || result.status === 'halted')
