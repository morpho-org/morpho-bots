import type { Logger } from '@repo/bot-kit'
import type { Address, Hex } from 'viem'

import { delay, fetchWithRetry, tryCatch } from '@repo/utils'
import createClient from 'openapi-fetch'
import { isAddress, isHex } from 'viem'

import type { components, paths } from '../generated/midnight-api'
import type { FetchPage } from './paginate.utils'

import { InvalidConfigError } from '../invalid-config.error'
import { collectPages } from './paginate.utils'

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
 * ONE source's view of the market whitelist: `GET /v0/midnight/markets?listed=true` defines the set of
 * markets the bot is allowed to touch. `isListed` gates borrower candidates before the lens read,
 * probing, and liquidation — a market not in the listed set is never acted on (fail-closed). The set is
 * refreshed on a timer and serves last-known-good on a transient API failure, so a blip never silently
 * widens or empties the whitelist mid-flight; only a never-successful first fetch yields an empty set
 * (safe). `snapshot().updatedAt` is the staleness signal — past `LISTED_MARKETS_MAX_AGE_MS` the set
 * must be treated as empty so a since-delisted market can never linger. Deployments read one or more
 * sources; {@link createUnionListedMarketFilter} composes them and applies that staleness rule.
 */
type ListedMarketFilter = {
  isListed: (marketId: Hex) => boolean
  /** This source's listed ids (lowercased), so the union can size the combined whitelist. */
  ids: () => ReadonlySet<string>
  refresh: () => Promise<void>
  snapshot: () => { source: string; markets: number; updatedAt: number | null }
}

/** The `fetch` shape `openapi-fetch` calls — a single `Request`. The global `fetch` satisfies it. */
type FetchLike = (request: Request) => Promise<Response>

const REQUEST_TIMEOUT_MS = 5_000

/**
 * Page size requested from the markets endpoint. Sent explicitly rather than relying on the server's
 * default, which is not ours to control and which the generated spec does not document at all (it
 * says only "Maximum number of items to return"). Verified accepted by the live endpoint. The walk
 * follows the cursor either way — this only trades round-trips.
 */
const PAGE_LIMIT = 100

/**
 * Runaway-cursor backstop for the whitelist walk, NOT an expected limit — the listed set is a handful
 * of markets. Reaching it means the whitelist was truncated, which is fail-closed under-inclusion
 * (listed markets silently dropped out of scope), so it logs loud via `markets.max_pages`.
 */
const MAX_MARKET_PAGES = 50

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
 * `fetchImpl`/`sleep`/`now` are injectable for tests.
 */
export function createListedMarketFilter(deps: {
  apiUrl: string
  chainId: number
  logger: Logger
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): ListedMarketFilter {
  const sleep = deps.sleep ?? delay
  const now = deps.now ?? (() => Date.now())
  const url = new URL(deps.apiUrl)
  const baseUrl = deps.apiUrl.endsWith(PATH) ? deps.apiUrl.slice(0, -PATH.length) : url.origin
  const client = createClient<paths>({ baseUrl, fetch: deps.fetchImpl ?? fetch })
  // Log/snapshot label for this source. Host + path, so two sources sharing a host but differing by
  // path prefix stay distinguishable in `markets.refresh_failed` / `markets.source_expired`; the query
  // string is excluded so no credential can ride along (these endpoints are public either way).
  const source = `${url.host}${url.pathname}`

  // Last-known-good: only replaced by a fully-successful refresh, so a transient failure keeps serving
  // the prior set rather than emptying the whitelist.
  let listed = new Set<string>()
  let updatedAt: number | null = null

  // Rows are branded to {@link ApiMarket} here, at the parse boundary, rather than after the walk:
  // this is where the response shape is actually known. `refresh` still validates every field it
  // consumes (`isHex` / `isAddress`) before trusting it.
  const fetchPage: FetchPage<ApiMarket> = async cursor => {
    const body = await fetchWithRetry(
      () =>
        client.GET(PATH, {
          params: {
            query: { listed: 'true', limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) }
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        }),
      { label: 'markets', sleep }
    )
    const nextCursor =
      typeof body.cursor === 'string' && body.cursor.length > 0 ? body.cursor : null
    return { cursor: nextCursor, data: Array.isArray(body.data) ? (body.data as ApiMarket[]) : [] }
  }

  const fetchListed = () =>
    collectPages(fetchPage, {
      logger: deps.logger,
      maxPages: MAX_MARKET_PAGES,
      event: 'markets.max_pages'
    })

  async function refresh(): Promise<void> {
    const rows = await fetchListed()
    const next = new Set<string>()
    for (const market of rows) {
      if (market.chain_id !== deps.chainId) continue
      if (!isHex(market.market_id)) continue
      if (!isAddress(market.loan_token, { strict: false })) continue
      next.add(market.market_id.toLowerCase())
    }
    // A successful-but-empty response is NOT a transient failure, so it legitimately replaces
    // last-known-good and stamps `updatedAt` — but it silently drops this source to zero markets, and
    // in a union a healthy peer would mask that entirely. Schema drift and an empty upstream database
    // both look like this, so a nonempty→empty transition is called out loud rather than left to be
    // inferred from `markets.listed { markets: 0 }` at info level.
    if (listed.size > 0 && next.size === 0) {
      deps.logger.warn('markets.listed_empty', {
        chainId: deps.chainId,
        source,
        previous: listed.size,
        detail: 'markets source returned zero listed markets where it previously returned some'
      })
    }
    listed = next
    updatedAt = now()
    deps.logger.info('markets.listed', { chainId: deps.chainId, source, markets: listed.size })
  }

  return {
    isListed: marketId => listed.has(marketId.toLowerCase()),
    ids: () => listed,
    refresh,
    snapshot: () => ({ source, markets: listed.size, updatedAt })
  }
}

/** One source's contribution to the union, as reported by {@link UnionListedMarketFilter.snapshot}. */
type UnionSourceSnapshot = {
  /** Host + path label of the endpoint this source reads (see the single-source `source` label). */
  source: string
  markets: number
  updatedAt: number | null
  /** `true` when this source is past `maxAgeMs` and therefore contributes nothing to the union. */
  expired: boolean
}

/**
 * The composed whitelist across every configured markets source: the UNION over sources that are still
 * fresh, so deployments can read more than one endpoint (e.g. the public list plus an additional list
 * carrying extra markets) without either endpoint becoming a single point of failure.
 */
type UnionListedMarketFilter = {
  /**
   * Freezes the currently-fresh source set and returns a predicate over it, so ONE discovery pass is
   * judged against ONE staleness reading. Re-deriving freshness per candidate would let a source cross
   * the max-age boundary mid-pass, splitting a single pass across two different whitelists.
   */
  current: () => { isListed: (marketId: Hex) => boolean; fresh: number }
  refresh: () => Promise<void>
  snapshot: () => { sources: UnionSourceSnapshot[]; fresh: number }
}

/**
 * Composes single-source {@link ListedMarketFilter}s into one union filter.
 *
 * The staleness rule is applied PER SOURCE: a source older than `maxAgeMs` (or never successfully
 * fetched) contributes nothing, while its still-fresh peers keep working. That is what makes reading
 * two endpoints safe in both directions — one endpoint going down or going stale narrows the whitelist
 * to the sources that are still trustworthy instead of either emptying it (halting all liquidations) or
 * letting a stale set keep a since-delisted market in scope.
 *
 * Union semantics are additive, so the whitelist is only ever as wide as the sources the operator
 * configured; it stays fail-closed on a cold start (every source has `updatedAt === null` → nothing is
 * listed). The flip side of additivity: an ACTIVE delisting takes effect only once every configured
 * source has dropped the market — one endpoint delisting it does not remove it while a peer still
 * lists it.
 *
 * `refresh` fans out to every source concurrently and NEVER throws: each source's failure is logged
 * (`markets.refresh_failed`, with its source label) and the others still land, because a partial
 * refresh must not read as a total one. It then emits `markets.whitelist` with the size of the combined
 * whitelist — the per-source `markets.listed` lines cannot be summed or maxed into that number — and
 * warns `markets.source_expired` when SOME sources are stale. The all-stale case is deliberately NOT
 * warned here: the whitelist being empty is a per-tick condition the caller reports every block (see
 * `markets.whitelist_expired` in the bot's `discover`), because a refresh interval longer than
 * `maxAgeMs` would otherwise leave the halt unreported for most of each interval.
 *
 * Throws if `filters` is empty: an empty union lists nothing, which is indistinguishable from a working
 * fail-closed whitelist and would halt every liquidation in silence.
 *
 * `now` is injectable for tests.
 */
export function createUnionListedMarketFilter(deps: {
  filters: ListedMarketFilter[]
  chainId: number
  maxAgeMs: number
  logger: Logger
  now?: () => number
}): UnionListedMarketFilter {
  if (deps.filters.length === 0) {
    throw new InvalidConfigError(
      'createUnionListedMarketFilter requires at least one markets source'
    )
  }
  const now = deps.now ?? (() => Date.now())
  const ageOf = (filter: ListedMarketFilter) => {
    const { updatedAt } = filter.snapshot()
    return updatedAt === null ? Infinity : now() - updatedAt
  }
  const isFresh = (filter: ListedMarketFilter) => ageOf(filter) <= deps.maxAgeMs
  const freshFilters = () => deps.filters.filter(isFresh)
  const snapshot = () => {
    const sources = deps.filters.map(filter => ({
      ...filter.snapshot(),
      expired: !isFresh(filter)
    }))
    return { sources, fresh: sources.filter(source => !source.expired).length }
  }
  // Size of the combined whitelist. Derived from the id sets rather than the per-source counts, which
  // overlap — summing them double-counts a market both sources list, and taking the max understates a
  // union of two partially-overlapping sets.
  const unionSize = () => new Set(freshFilters().flatMap(filter => [...filter.ids()])).size
  const warnExpiry = () => {
    const { sources, fresh } = snapshot()
    const expired = sources.filter(source => source.expired).map(source => source.source)
    // fresh === 0 is the caller's per-tick signal, not ours — see this factory's JSDoc.
    if (expired.length === 0 || fresh === 0) return
    deps.logger.warn('markets.source_expired', {
      chainId: deps.chainId,
      expired,
      maxAgeMs: deps.maxAgeMs,
      detail:
        'markets source older than max age — excluded from the whitelist until a refresh lands'
    })
  }

  return {
    current: () => {
      const fresh = freshFilters()
      return {
        isListed: marketId => fresh.some(filter => filter.isListed(marketId)),
        fresh: fresh.length
      }
    },
    refresh: async () => {
      await Promise.all(
        deps.filters.map(async filter => {
          const { error } = await tryCatch(filter.refresh())
          if (error) {
            deps.logger.warn('markets.refresh_failed', {
              chainId: deps.chainId,
              source: filter.snapshot().source,
              detail: error.message
            })
          }
        })
      )
      const { sources, fresh } = snapshot()
      deps.logger.info('markets.whitelist', {
        chainId: deps.chainId,
        markets: unionSize(),
        sources: sources.length,
        fresh
      })
      warnExpiry()
    },
    snapshot
  }
}
