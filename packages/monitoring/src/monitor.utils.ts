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
 * @returns Whether monitoring must stop before another cycle begins.
 */
export const cycleHasFailure = (results: readonly { status: string }[]) =>
  results.some(result => result.status === 'failed' || result.status === 'halted')
