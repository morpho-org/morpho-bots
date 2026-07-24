import type { Logger } from '@repo/bot-kit'
import type { Address, Hex } from 'viem'

import { delay, fetchWithRetry } from '@repo/utils'
import createClient from 'openapi-fetch'
import { isAddress, isHex } from 'viem'

import type { MarketListing } from '../config'
import type { components, paths } from '../generated/midnight-api'

// Response shapes from `GET /v0/midnight/markets` (the seed script imports these too). The spec types
// ids/addresses as plain strings; we brand the fields the codebase consumes as viem `Hex`/`Address`
// (validated at runtime in `refresh`). The rest of the generated shape (maturity, fees, …) passes
// through untouched, and is intentionally ignored by the whitelist.
type ApiMarketRow = components['schemas']['MarketsResponse']['data'][number]
export type ApiCollateral = Omit<ApiMarketRow['collaterals'][number], 'token' | 'oracle'> & {
  token: Address
  oracle: Address
}
export type ApiMarket = Omit<ApiMarketRow, 'market_id' | 'loan_token' | 'collaterals'> & {
  market_id: Hex
  loan_token: Address
  collaterals: ApiCollateral[]
}

/**
 * The market whitelist: `GET /v0/midnight/markets` defines the set of markets the bot is allowed to
 * touch. The `listing` mode picks the slice — `listed` (`?listed=true`, the production default),
 * `unlisted` (`?listed=false`), or `all` (param omitted). `isListed` gates borrower candidates before
 * the lens read, probing, and liquidation — a market not in the set is never acted on (fail-closed).
 * The set is refreshed on a timer and serves last-known-good on a transient API failure, so a blip
 * never silently widens or empties the whitelist mid-flight; only a never-successful first fetch
 * yields an empty set (safe). `snapshot().updatedAt` is the caller's staleness signal — past
 * `LISTED_MARKETS_MAX_AGE_MS` the caller must treat the set as empty (fail-closed) so a since-delisted
 * market can never linger.
 */
type ListedMarketFilter = {
  isListed: (marketId: Hex) => boolean
  refresh: () => Promise<void>
  snapshot: () => { markets: number; updatedAt: number | null }
}

/** The `fetch` shape `openapi-fetch` calls — a single `Request`. The global `fetch` satisfies it. */
type FetchLike = (request: Request) => Promise<Response>

const REQUEST_TIMEOUT_MS = 5_000
/** Page size for the whitelist walk — the `listed`/`all` slices span more than one default page. */
const PAGE_LIMIT = 100
/**
 * Hard cap on pages followed in one refresh — a runaway-cursor backstop, NOT an expected limit.
 * `listed=true` is a small set (a page or two); `unlisted`/`all` are larger, so the walk paginates.
 * Hitting the cap is logged loud (`markets.max_pages`) because silently truncating the whitelist is
 * *under-inclusion* — a liquidatable position we would then never act on (fail-closed).
 */
const MAX_MARKET_PAGES = 100

/**
 * The markets-list operation path — a literal key of the generated {@link paths}, so `client.GET(PATH)`
 * is type-checked against the spec. The runtime base URL is derived by stripping this suffix from the
 * configured endpoint URL.
 */
const PATH = '/v0/midnight/markets'

/**
 * Builds the {@link ListedMarketFilter}, via a typed `openapi-fetch` client generated from the
 * Midnight API spec. `openapi-fetch` builds the URL, serializes the query, and parses/types the body;
 * this keeps the bespoke retry policy it does NOT provide via {@link fetchWithRetry} (429/5xx/network,
 * honoring `Retry-After`), with a {@link REQUEST_TIMEOUT_MS} deadline.
 * `deps.apiUrl` is the full endpoint URL from config; the client base URL is it minus the fixed
 * {@link PATH} suffix (an override of `MARKETS_API_URL` changes host/prefix, not the request path).
 * `deps.listing` selects the slice (`listed` default / `unlisted` / `all`); the walk follows the
 * cursor across every page so a multi-page slice is never silently truncated.
 * `fetchImpl`/`sleep`/`now` are injectable for tests.
 */
export function createListedMarketFilter(deps: {
  apiUrl: string
  listing?: MarketListing
  chainId: number
  logger: Logger
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): ListedMarketFilter {
  const sleep = deps.sleep ?? delay
  const now = deps.now ?? (() => Date.now())
  const baseUrl = deps.apiUrl.endsWith(PATH)
    ? deps.apiUrl.slice(0, -PATH.length)
    : new URL(deps.apiUrl).origin
  const client = createClient<paths>({ baseUrl, fetch: deps.fetchImpl ?? fetch })
  // The configured slice → the `?listed=` query value; `all` omits the param to return both.
  const listing = deps.listing ?? 'listed'
  const listedParam = listing === 'all' ? undefined : listing === 'unlisted' ? 'false' : 'true'

  // Last-known-good: only replaced by a fully-successful refresh, so a transient failure keeps serving
  // the prior set rather than emptying the whitelist.
  let listed = new Set<string>()
  let updatedAt: number | null = null

  // Walks every page of the configured slice, following the cursor. Over-inclusion is harmless (the
  // lens filters non-liquidatable pairs); a truncated walk would be under-inclusion, so the
  // {@link MAX_MARKET_PAGES} backstop logs loud rather than silently stopping.
  async function fetchListed(): Promise<ApiMarket[]> {
    const markets: ApiMarket[] = []
    let cursor: string | null = null
    let pages = 0

    do {
      const body = await fetchWithRetry(
        () =>
          client.GET(PATH, {
            params: {
              query: {
                limit: PAGE_LIMIT,
                ...(listedParam === undefined ? {} : { listed: listedParam }),
                ...(cursor ? { cursor } : {})
              }
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          }),
        { label: 'markets', sleep }
      )
      if (Array.isArray(body.data)) markets.push(...(body.data as ApiMarket[]))
      cursor = typeof body.cursor === 'string' && body.cursor.length > 0 ? body.cursor : null
      pages += 1
      if (cursor && pages >= MAX_MARKET_PAGES) {
        deps.logger.warn('markets.max_pages', {
          pages,
          cap: MAX_MARKET_PAGES,
          collected: markets.length
        })
        break
      }
    } while (cursor)

    return markets
  }

  async function refresh(): Promise<void> {
    const rows = await fetchListed()
    const next = new Set<string>()
    for (const market of rows) {
      if (market.chain_id !== deps.chainId) continue
      if (!isHex(market.market_id)) continue
      if (!isAddress(market.loan_token, { strict: false })) continue
      next.add(market.market_id.toLowerCase())
    }
    listed = next
    updatedAt = now()
    deps.logger.info('markets.listed', { chainId: deps.chainId, listing, markets: listed.size })
  }

  return {
    isListed: marketId => listed.has(marketId.toLowerCase()),
    refresh,
    snapshot: () => ({ markets: listed.size, updatedAt })
  }
}
