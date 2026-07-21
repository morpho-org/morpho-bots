import type { ApiResult } from '@repo/utils'

import { backoffMs, ensureError, retryAfterMs, tryCatch } from '@repo/utils'

const MAX_REQUEST_RETRIES = 3

/** Raised by the Midnight client while the upstream `Retry-After` cooldown is active. */
export class MidnightRateLimitError extends Error {
  constructor(readonly retryAt: number) {
    super(`rate limited until ${new Date(retryAt).toISOString()}`)
    this.name = 'MidnightRateLimitError'
  }
}

/**
 * Midnight request retry policy. The client itself owns 429 cooldowns, so a rate-limit error must
 * escape immediately: sleeping inside a cron tick would make `waitForCompletion` skip every tick
 * for the API's full Retry-After window. Network and 5xx failures keep the shared retry semantics.
 */
export async function fetchMidnightWithRetry<T>(
  request: () => Promise<ApiResult<T>>,
  deps: { label: string; sleep: (ms: number) => Promise<void>; maxRetries?: number }
): Promise<T> {
  const maxRetries = deps.maxRetries ?? MAX_REQUEST_RETRIES
  for (let attempt = 0; ; attempt++) {
    const call = await tryCatch(request())

    if (call.error) {
      if (call.error instanceof MidnightRateLimitError) {
        throw new Error(`${deps.label} ${call.error.message}`, { cause: call.error })
      }
      if (attempt < maxRetries) {
        await deps.sleep(backoffMs(attempt))
        continue
      }
      throw new Error(`${deps.label} request failed: ${ensureError(call.error).message}`)
    }

    const { data: body, response } = call.data

    // `createMidnightClient` turns an upstream 429 into MidnightRateLimitError after recording the
    // cooldown. Keep this fallback fail-fast for test doubles or any alternate client adapter.
    if (response.status === 429) throw new Error(`${deps.label} HTTP 429`)
    if (response.status >= 500) {
      if (attempt < maxRetries) {
        await deps.sleep(retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt))
        continue
      }
      throw new Error(`${deps.label} HTTP ${response.status}`)
    }
    if (!response.ok) throw new Error(`${deps.label} HTTP ${response.status}`)
    if (!body) throw new Error(`${deps.label} parse error: empty body`)
    return body
  }
}
