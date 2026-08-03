/**
 * Detects whether a writer cycle reported a terminal failure.
 * @param results - Status-bearing results emitted by one bootstrap or ladder cycle.
 * @returns `true` when any result failed or halted; otherwise `false`.
 */
export const marketMakingCycleHasFailure = (results: readonly { status: string }[]) =>
  results.some(result => result.status === 'failed' || result.status === 'halted')
