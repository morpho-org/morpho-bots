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
