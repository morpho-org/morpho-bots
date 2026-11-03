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

import { QuoteError } from './errors'

/**
 * The hosts this client rate-limits and authenticates: the swap venues plus Pendle's hosted SDK
 * (an unwrapper data source, not a `Venue` — widening `Venue` itself would ripple through the
 * config union and every `assertNever` venue switch for a host that never quotes a full route).
 */
export type HttpVenue = Venue | 'pendle'

/** How long a venue that answered 429 without a `Retry-After` is left alone. */
const RATE_LIMIT_COOLDOWN_MS = 60_000

// Per-host auth: where each host's API key goes. Uniswap is onchain (no key). Keys are injected
// here, at the single point of use, and never logged (we log only the path, never the query/headers).
const VENUE_AUTH: Record<HttpVenue, (key: string | undefined) => Record<string, string>> = {
  'uniswap-v3': () => ({}),
  '0x': key => ({ '0x-api-key': key ?? '', '0x-version': 'v2' }),
  '1inch': key => ({ Authorization: `Bearer ${key ?? ''}` }),
  // LiFi works keyless (a key only raises rate limits), but it rejects an EMPTY `x-lifi-api-key`
  // header with HTTP 401 — so omit the header entirely when no key is configured.
  lifi: (key): Record<string, string> => (key ? { 'x-lifi-api-key': key } : {}),
  // LiquidSwap (liqd.ag) is keyless — no auth header.
  liquidswap: () => ({}),
  // Pendle's hosted SDK is keyless — no auth header.
  pendle: () => ({})
}

/** The rate-limited JSON client shared across venues — see {@link createRateLimitedClient}. */
export type RateLimitedClient = {
  getJson: <T>(args: {
    venue: HttpVenue
    url: string
    searchParams?: Record<string, string>
  }) => Promise<T>
  /**
   * Requests actually put on the wire since the client was built, monotonic across every venue.
   *
   * Counts TRANSPORT attempts, so one `getJson` that retried a 429 counts more than once — which is
   * the whole point: a budget expressed in `getJson` calls under-reports a rate-limited window by up
   * to `maxRetries + 1`. Read it as a delta around the work being measured.
   *
   * Optional so a test fake need not implement it; a caller must degrade rather than assume it.
   */
  requests?: () => number
}

/** Minimal `fetch` shape the client calls — the global `fetch` satisfies it; test fakes need not. */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Rate-limited JSON client with a token bucket per venue. Retries 429/5xx/network up to `maxRetries`,
 * honoring a `Retry-After` no longer than `timeoutMs` and failing at once past it, so an exhausted
 * quota never parks a caller. A venue whose last answer was 429 then fails `rate_limited` without a
 * request until its `Retry-After` passes. Throws a {@link QuoteError} carrying a classified reason.
 */
export function createRateLimitedClient(deps: {
  apiKeys: Partial<Record<HttpVenue, string>>
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
  const buckets = new Map<HttpVenue, { take: () => Promise<void> }>()
  const cooledUntil = new Map<HttpVenue, number>()
  const refuseWhileCooling = (venue: HttpVenue) => {
    if (now() < (cooledUntil.get(venue) ?? 0))
      throw new QuoteError('rate_limited', `${venue} is cooling down after HTTP 429`)
  }
  const coolAfter = (venue: HttpVenue, status: number, hinted: number | undefined) => {
    if (status !== 429) return
    const until = now() + (hinted ?? RATE_LIMIT_COOLDOWN_MS)
    cooledUntil.set(venue, Math.max(until, cooledUntil.get(venue) ?? 0))
  }
  let requests = 0
  const bucketFor = (venue: HttpVenue) => {
    let bucket = buckets.get(venue)
    if (!bucket) {
      bucket = createTokenBucket({ rps: deps.rps, burst: deps.burst, now, sleep })
      buckets.set(venue, bucket)
    }
    return bucket
  }

  return {
    requests: () => requests,

    async getJson<T>(args: {
      venue: HttpVenue
      url: string
      searchParams?: Record<string, string>
    }) {
      const url = new URL(args.url)
      for (const [key, value] of Object.entries(args.searchParams ?? {})) {
        url.searchParams.set(key, value)
      }
      const headers = VENUE_AUTH[args.venue](deps.apiKeys[args.venue])
      refuseWhileCooling(args.venue)

      for (let attempt = 0; ; attempt++) {
        await bucketFor(args.venue).take()
        refuseWhileCooling(args.venue)
        requests += 1
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
          const hinted = retryAfterMs(response.headers.get('retry-after'))
          if (attempt < deps.maxRetries && (hinted === undefined || hinted <= deps.timeoutMs)) {
            await sleep(hinted ?? backoffMs(attempt))
            continue
          }
          coolAfter(args.venue, response.status, hinted)
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
