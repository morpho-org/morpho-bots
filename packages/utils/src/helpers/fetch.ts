import type { Result } from '../types/index'

import { ensureError } from './errors'
import { tryCatch } from './tryCatch'

/** Exponential backoff (ms) for retry attempt `n` (0-indexed): 200·2ⁿ → 200, 400, 800, … */
export function backoffMs(attempt: number): number {
  return 200 * 2 ** attempt
}

/** Parses a `Retry-After` header (delta-seconds) into ms; `undefined` if absent or malformed. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

/**
 * Safely parse a `Response` as JSON. When parsing fails, reads the body as text to detect HTML
 * error pages (e.g. Cloudflare 502/429) and extracts the `<title>` or a body snippet so that
 * callers get an actionable error message instead of `SyntaxError: Unexpected token '<'`.
 */
export async function parseJsonResponse<T>(response: Response): Promise<Result<T, Error>> {
  const text = await response.text()

  try {
    return { data: JSON.parse(text) as T, error: null }
  } catch {
    const isHtml = text.trimStart().startsWith('<')
    if (isHtml) {
      const title = text.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim()
      const snippet = title || text.slice(0, 200)
      return {
        data: null,
        error: Error(`Upstream returned HTML (HTTP ${response.status}): ${snippet}`)
      }
    }

    return {
      data: null,
      error: Error(`Failed to parse response (HTTP ${response.status}): ${text.slice(0, 200)}`)
    }
  }
}

/** Default retry budget for {@link fetchWithRetry} (429/5xx/network with `Retry-After`). */
const MAX_REQUEST_RETRIES = 3

/**
 * The subset of an HTTP request result {@link fetchWithRetry} reads: the parsed body and the raw
 * `Response` (for `status`/`Retry-After`). The request callback must resolve on HTTP errors and
 * throw only on network/abort failures, so both stay reachable — plain `fetch` and `openapi-fetch`
 * clients both satisfy this.
 */
export type ApiResult<T> = { data?: T; response: Response }

/**
 * Runs one HTTP request under a small self-contained retry policy: 429/5xx/network-error retries up
 * to {@link MAX_REQUEST_RETRIES} times, honoring `Retry-After` (falling back to exponential
 * backoff); a non-retryable failure throws `${label} …`. `tryCatch` catches the network/abort
 * throw, while a resolved HTTP error surfaces via `response.status`. Returns the parsed body once a
 * 2xx/3xx response with a non-empty body arrives. `sleep` is injected for tests.
 *
 * NOTE: every throw from `request` is treated as a retryable network failure — parse or validate
 * response bodies AFTER this loop, not inside the callback, or request-level rejections will be
 * retried.
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

    // A non-429 4xx (e.g. 400 bad params) is a request-level rejection — not worth retrying with
    // the same URL. Surface it so the caller logs and moves on.
    if (!response.ok) throw new Error(`${deps.label} HTTP ${response.status}`)
    if (!body) throw new Error(`${deps.label} parse error: empty body`)
    return body
  }
}

export async function fetchJsonResponse<T>(url: string, requestInit?: RequestInit): Promise<T> {
  const { data: response, error: fetchError } = await tryCatch(fetch(url, requestInit))

  if (fetchError || !response?.ok) {
    throw Error(`HTTP ${response?.status ?? 'network error'}: ${url}`, { cause: fetchError })
  }

  const { data, error: parseError } = await parseJsonResponse<T>(response)
  if (parseError) {
    throw Error(`Failed to parse JSON: ${url}`, { cause: parseError })
  }

  return data
}
