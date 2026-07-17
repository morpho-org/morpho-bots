import { backoffMs, ensureError, retryAfterMs, tryCatch } from '@repo/utils'

/**
 * Default retry budget shared by the discovery `openapi-fetch` clients. Mirrors the retry conventions
 * in `@repo/swaps` http-client (429/5xx/network with `Retry-After`), but these endpoints are
 * unauthenticated and not venue-keyed, so they use this small self-contained loop rather than the
 * venue rate-limiter.
 */
const MAX_REQUEST_RETRIES = 3

/**
 * The subset of an `openapi-fetch` `client.GET` result this loop reads: the parsed body and the raw
 * `Response` (for `status`/`Retry-After`). `client.GET` resolves on 4xx/5xx and only throws on
 * network/abort, so both stay reachable.
 */
type ApiResult<T> = { data?: T; response: Response }

/**
 * Runs one `openapi-fetch` request under the discovery retry policy: 429/5xx/network-error retries up
 * to {@link MAX_REQUEST_RETRIES} times, honoring `Retry-After` (falling back to exponential backoff);
 * a non-retryable failure throws `${label} …`. `tryCatch` catches the network/abort throw, while a
 * resolved HTTP error surfaces via `response.status`. Returns the parsed body once a 2xx/3xx response
 * with a non-empty body arrives. `sleep` is injected for tests.
 */
export async function fetchWithRetry<T>(
  request: () => Promise<ApiResult<T>>,
  deps: { label: string; sleep: (ms: number) => Promise<void>; maxRetries?: number }
): Promise<T> {
  const maxRetries = deps.maxRetries ?? MAX_REQUEST_RETRIES
  for (let attempt = 0; ; attempt++) {
    const call = await tryCatch(request())

    if (call.error) {
      if (attempt < maxRetries) {
        await deps.sleep(backoffMs(attempt))
        continue
      }
      throw new Error(`${deps.label} request failed: ${ensureError(call.error).message}`)
    }

    const { data: body, response } = call.data

    if (response.status === 429 || response.status >= 500) {
      if (attempt < maxRetries) {
        await deps.sleep(retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt))
        continue
      }
      throw new Error(`${deps.label} HTTP ${response.status}`)
    }

    // A non-429 4xx (e.g. 400 INVALID_CURSOR / bad params) is a request-level rejection — not worth
    // retrying with the same URL. Surface it so the caller logs and moves on.
    if (!response.ok) throw new Error(`${deps.label} HTTP ${response.status}`)
    if (!body) throw new Error(`${deps.label} parse error: empty body`)
    return body
  }
}
