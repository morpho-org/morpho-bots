import { delay } from '@repo/utils'

const MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 4_000
const JITTER_SHARE = 0.5
const RETRYABLE_STATUSES = new Set([408, 429])
const SERVER_ERROR_MINIMUM_STATUS = 500

const isTransientFailure = (error: unknown) => {
  if (typeof error !== 'object' || error === null || !('failure' in error)) return false
  const { failure } = error
  if (typeof failure !== 'object' || failure === null) return false
  const { name, status } = failure as { name?: unknown; status?: unknown }
  if (typeof name !== 'string') return false
  if (name === 'TimeoutError' || name === 'NetworkError') return true
  if (typeof status !== 'number') return false
  return RETRYABLE_STATUSES.has(status) || status >= SERVER_ERROR_MINIMUM_STATUS
}

const backoffDelayMs = (failures: number) => {
  const capped = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failures - 1))
  const fixed = capped * (1 - JITTER_SHARE)
  return fixed + Math.random() * (capped - fixed)
}

/**
 * Re-runs an idempotent read-only provider request while its failures look transient.
 * @param attempt - Deferred read-only request receiving the remaining aggregate timeout when one is
 * configured; it is invoked at most three times and must be safe to repeat, since no attempt is
 * cancelled or compensated.
 * @param timeoutMs - Optional aggregate deadline shared by attempts and backoff waits.
 * @returns The first successful attempt's value.
 * @throws The final attempt's error unchanged — a sanitized `SafeProviderError` for provider
 * failures — so callers keep today's halt behavior and operator-visible metadata. Non-transient
 * failures (any error that is not a timeout, network fault, or HTTP 408/429/5xx `SafeProviderError`)
 * are rethrown immediately without a retry.
 * @remarks Waits a half-jittered exponential backoff between attempts (500 ms base, 4 s cap). An
 * aggregate deadline shortens the final wait and prevents a further attempt after it expires.
 */
export const retryTransientProviderRead = async <Result>(
  attempt: (remainingMs?: number) => Promise<Result>,
  timeoutMs?: number
) => {
  const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs
  let lastError: unknown
  for (let failures = 1; ; failures += 1) {
    const remainingMs =
      deadline === undefined ? undefined : Math.floor(deadline - performance.now())
    if (remainingMs !== undefined && remainingMs <= 0) throw lastError
    try {
      return await attempt(remainingMs)
    } catch (error) {
      lastError = error
      if (failures >= MAX_ATTEMPTS || !isTransientFailure(error)) throw error
      const backoffMs = backoffDelayMs(failures)
      const remainingAfterFailure =
        deadline === undefined ? undefined : Math.floor(deadline - performance.now())
      if (remainingAfterFailure !== undefined && remainingAfterFailure <= 0) throw error
      const delayMs =
        remainingAfterFailure === undefined ? backoffMs : Math.min(backoffMs, remainingAfterFailure)
      if (delayMs <= 0) throw error
      await delay(delayMs)
    }
  }
}
