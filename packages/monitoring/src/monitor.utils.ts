/** Serial execution boundary for one complete monitor operation. */
export type MonitorOperationQueue = <Result>(operation: () => Promise<Result>) => Promise<Result>

/**
 * Waits between continuous workflow observations and resolves early on shutdown.
 * @param intervalMs - Positive monitoring interval in milliseconds.
 * @param signal - Runtime shutdown signal.
 * @returns Completion after the interval elapses or the signal is aborted.
 * @remarks The abort listener and timer are both removed before resolution.
 */
export const waitForMonitorInterval = (intervalMs: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }

    const complete = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', complete)
      resolve()
    }
    const timer = setTimeout(complete, intervalMs)
    signal.addEventListener('abort', complete, { once: true })
  })

/**
 * Creates one failure-tolerant serial queue for complete monitor operations.
 * @returns A boundary that runs each submitted operation after every preceding operation settles.
 */
export const createOperationQueue = (): MonitorOperationQueue => {
  let queue = Promise.resolve()
  return <Result>(operation: () => Promise<Result>) => {
    const result = queue.then(operation, operation)
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

/**
 * Detects whether a completed monitor cycle entered a handled failure or safety halt.
 * @param results - Ordered sanitized outcomes from one complete cycle.
 * @returns Whether any entry of the cycle failed.
 * @remarks Reports what happened, not what to do about it. A continuous monitor decides with
 * {@link cycleRequiresHalt}; a one-shot command uses this to choose its exit code.
 */
export const cycleHasFailure = (results: readonly { status: string }[]) =>
  results.some(result => result.status === 'failed' || result.status === 'halted')

/**
 * Detects whether a completed monitor cycle left onchain state too unproven to continue.
 * @param results - Ordered sanitized outcomes from one complete cycle.
 * @returns Whether monitoring must stop instead of retrying on the next interval.
 * @remarks A `failed` entry is handled: the cycle classified it, recorded it, and left the market
 * in a state the next cycle re-derives from live truth, so it can be retried while its peers keep
 * quoting. It does **not** promise the market is flat — a publication rejected before its
 * replacement set is invalidated leaves the previous offers live — so a caller that retries must
 * bound how long it does so. `halted` means an invalidation or cleanup write itself failed, leaving
 * live offers the bot can no longer account for, and is never retryable.
 */
export const cycleRequiresHalt = (results: readonly { status: string }[]) =>
  results.some(result => result.status === 'halted')
