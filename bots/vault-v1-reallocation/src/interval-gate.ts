/**
 * Wall-clock rate limiter for the per-block tick: the returned predicate passes on its first call and
 * then only once `intervalMs` has elapsed since the last pass it admitted, recording the new instant
 * as it does so. `now` is injectable for tests; production uses `Date.now`.
 */
export const createIntervalGate = (
  intervalMs: number,
  now: () => number = Date.now
): (() => boolean) => {
  let lastPassMs: number | undefined
  return () => {
    const current = now()
    if (lastPassMs !== undefined && current - lastPassMs < intervalMs) return false
    lastPassMs = current
    return true
  }
}
