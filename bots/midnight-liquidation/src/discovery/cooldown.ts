import type { Logger } from '@repo/bot-kit'

import { HttpRetryExhaustedError } from '@repo/utils'

import type { BorrowerCandidate } from './borrowers'

/**
 * Cross-tick discovery circuit breaker (CRTR-2857). `fetchWithRetry` honors a 429's `Retry-After`
 * WITHIN one discovery pass, but the runner re-fires a full pass every ~2s block with no memory
 * that the last one was throttled — under a sustained throttle that re-hammering IS the outage
 * (the candidates endpoint's server-side GraphQL fan-out shares ONE global WAF budget across all
 * bot instances). This wrapper adds the missing cross-tick memory: after a failed pass, discovery
 * is latched off until a backoff window expires, and each latched tick returns zero candidates —
 * which the tick already tolerates (discovery is a coverage source, never a correctness
 * dependency), so backing off a throttled endpoint costs ~nothing and lets it recover.
 *
 * The window is `min(maxMs, max(serverRetryAfter, baseMs · 2^(failures−1)))`: seeded from the
 * server's own `Retry-After` when the failure surfaced one (via {@link HttpRetryExhaustedError}),
 * with the exponential ramp as a floor so a degenerate short header can't defeat the breaker.
 * `baseMs = 0` disables the exponential floor (a server `Retry-After` is still honored). The first
 * successful pass resets the latch and the failure count.
 *
 * Failures still propagate to the caller (the tick logs `discover.error` as before); this wrapper
 * additionally logs `discover.cooldown_start` when latching and `discover.cooldown` on each
 * skipped pass. `now` is injectable for tests.
 */
export function withDiscoveryCooldown(
  discover: () => Promise<BorrowerCandidate[]>,
  deps: { logger: Logger; baseMs: number; maxMs: number; now?: () => number }
): () => Promise<BorrowerCandidate[]> {
  const now = deps.now ?? (() => Date.now())
  let cooldownUntil = 0
  let failures = 0

  return async () => {
    const at = now()
    if (at < cooldownUntil) {
      deps.logger.info('discover.cooldown', { remainingMs: cooldownUntil - at, failures })
      return []
    }
    try {
      const candidates = await discover()
      if (failures > 0) deps.logger.info('discover.cooldown_reset', { failures })
      failures = 0
      cooldownUntil = 0
      return candidates
    } catch (error) {
      failures += 1
      const serverRetryAfterMs =
        error instanceof HttpRetryExhaustedError ? error.retryAfterMs : undefined
      const cooldownMs = Math.min(
        deps.maxMs,
        Math.max(serverRetryAfterMs ?? 0, deps.baseMs * 2 ** (failures - 1))
      )
      cooldownUntil = now() + cooldownMs
      deps.logger.warn('discover.cooldown_start', {
        failures,
        cooldownMs,
        retryAfterMs: serverRetryAfterMs ?? null
      })
      throw error
    }
  }
}
