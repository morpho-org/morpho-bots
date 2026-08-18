import { delay } from '@repo/utils'

import { SafeProviderError } from '../../application/setup/safe-provider.error'

const MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 4_000
const JITTER_SHARE = 0.5
const RETRYABLE_STATUSES = new Set([408, 429])
const SERVER_ERROR_MINIMUM_STATUS = 500

const isTransientFailure = (error: unknown) => {
  if (!(error instanceof SafeProviderError)) return false
  const { name, status } = error.failure
  if (name === 'TimeoutError' || name === 'NetworkError') return true
  if (status === undefined) return false
  return RETRYABLE_STATUSES.has(status) || status >= SERVER_ERROR_MINIMUM_STATUS
}

const backoffDelayMs = (failures: number) => {
  const capped = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failures - 1))
  const fixed = capped * (1 - JITTER_SHARE)
  return fixed + Math.random() * (capped - fixed)
}

/**
 * Re-runs an idempotent read-only provider request while its failures look transient.
 * @param attempt - Deferred read-only request; it is invoked at most three times and must be safe
 * to repeat, since no attempt is cancelled or compensated.
 * @returns The first successful attempt's value.
 * @throws The final attempt's error unchanged — a sanitized `SafeProviderError` for provider
 * failures — so callers keep today's halt behavior and operator-visible metadata. Non-transient
 * failures (any error that is not a timeout, network fault, or HTTP 408/429/5xx `SafeProviderError`)
 * are rethrown immediately without a retry.
 * @remarks Waits a half-jittered exponential backoff between attempts (500 ms base, 4 s cap), so
 * the worst-case added latency stays around 1.5 s and well inside the monitor cycle interval.
 */
export const retryTransientProviderRead = async <Result>(attempt: () => Promise<Result>) => {
  for (let failures = 1; ; failures += 1) {
    try {
      return await attempt()
    } catch (error) {
      if (failures >= MAX_ATTEMPTS || !isTransientFailure(error)) throw error
      await delay(backoffDelayMs(failures))
    }
  }
}
