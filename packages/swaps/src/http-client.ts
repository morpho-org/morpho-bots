import {
  backoffMs,
  createTokenBucket,
  delay,
  ensureError,
  parseJsonResponse,
  retryAfterMs,
  tryCatch
} from '@repo/utils'

import type { Venue } from './types'

import { QuoteError } from './types'

// Per-venue auth: where each venue's API key goes. Uniswap is on-chain (no key). Keys are injected
// here, at the single point of use, and never logged (we log only the path, never the query/headers).
const VENUE_AUTH: Record<Venue, (key: string | undefined) => Record<string, string>> = {
  'uniswap-v3': () => ({}),
  '0x': key => ({ '0x-api-key': key ?? '', '0x-version': 'v2' }),
  '1inch': key => ({ Authorization: `Bearer ${key ?? ''}` }),
  // LiFi works keyless (a key only raises rate limits), but it rejects an EMPTY `x-lifi-api-key`
  // header with HTTP 401 — so omit the header entirely when no key is configured.
  lifi: (key): Record<string, string> => (key ? { 'x-lifi-api-key': key } : {})
}

/** The rate-limited JSON client shared across venues — see {@link createRateLimitedClient}. */
export type RateLimitedClient = {
  getJson: <T>(args: {
    venue: Venue
    url: string
    searchParams?: Record<string, string>
  }) => Promise<T>
}

/** Minimal `fetch` shape the client calls — the global `fetch` satisfies it; test fakes need not. */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * A rate-limited JSON HTTP client shared across venues. Each venue gets its own token bucket (their
 * limits differ — 1inch's free tier is 1 RPS). Retries 429/5xx/network up to `maxRetries`, honoring
 * `Retry-After`; per-request deadline is `timeoutMs`. Calls `fetch` directly (not `fetchJsonResponse`)
 * because it needs the raw `Response` to read `status` + the `Retry-After` header for backoff. Throws
 * a {@link QuoteError} carrying a classified reason on exhaustion.
 */
export function createRateLimitedClient(deps: {
  apiKeys: Partial<Record<Venue, string>>
  rps: number
  burst: number
  maxRetries: number
  timeoutMs: number
  fetchImpl?: FetchLike
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): RateLimitedClient {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? delay
  const buckets = new Map<Venue, { take: () => Promise<void> }>()
  const bucketFor = (venue: Venue) => {
    let bucket = buckets.get(venue)
    if (!bucket) {
      bucket = createTokenBucket({ rps: deps.rps, burst: deps.burst, now, sleep })
      buckets.set(venue, bucket)
    }
    return bucket
  }

  return {
    async getJson<T>(args: { venue: Venue; url: string; searchParams?: Record<string, string> }) {
      const url = new URL(args.url)
      for (const [key, value] of Object.entries(args.searchParams ?? {})) {
        url.searchParams.set(key, value)
      }
      const headers = VENUE_AUTH[args.venue](deps.apiKeys[args.venue])

      for (let attempt = 0; ; attempt++) {
        await bucketFor(args.venue).take()
        const { data: response, error: networkError } = await tryCatch(
          fetchImpl(url.toString(), { headers, signal: AbortSignal.timeout(deps.timeoutMs) })
        )

        if (networkError) {
          const isTimeout =
            networkError.name === 'TimeoutError' || networkError.name === 'AbortError'
          if (attempt < deps.maxRetries) {
            await sleep(backoffMs(attempt))
            continue
          }
          throw new QuoteError(
            isTimeout ? 'timeout' : 'api_error',
            `${args.venue} request failed: ${ensureError(networkError).message}`
          )
        }

        if (response.status === 429 || response.status >= 500) {
          if (attempt < deps.maxRetries) {
            await sleep(retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt))
            continue
          }
          throw new QuoteError(
            response.status === 429 ? 'rate_limited' : 'api_error',
            `${args.venue} HTTP ${response.status} (${url.pathname})`
          )
        }

        const { data, error: parseError } = await parseJsonResponse<T>(response)
        if (!response.ok) {
          // A non-429 4xx is a request-level rejection (no route, bad params) — do not retry. 401/403
          // is a key problem; everything else we treat as no-route for backoff purposes.
          const reason =
            response.status === 401 || response.status === 403 ? 'api_error' : 'no_route'
          throw new QuoteError(reason, `${args.venue} HTTP ${response.status} (${url.pathname})`)
        }
        if (parseError) {
          throw new QuoteError('api_error', `${args.venue}: ${parseError.message}`)
        }
        return data
      }
    }
  }
}
