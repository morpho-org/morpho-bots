import type { Logger } from '@repo/kit'
import type { CursorPage, FetchPage } from '@repo/utils'
import type { Address, Hex } from 'viem'

import { delay, fetchWithRetry, tryCatch } from '@repo/utils'
import { getAddress, isAddress } from 'viem'

import type { MarketParams } from '../market'
import type { MarketParamsResolver } from '../state/market-params'

import { CandidatesApiRefusedError, CandidatesApiResponseError } from '../errors'

/** A discovered (market id, borrower) pair from the candidates API, before params are resolved. */
type BorrowerId = { marketId: Hex; borrower: Address }

/** A candidate position to evaluate: a (market, borrower) pair, with the market's immutable params
 * resolved onchain via `idToMarketParams(id)` (see ../state/market-params.ts). */
export type BorrowerCandidate = { marketParams: MarketParams; borrower: Address }

/**
 * Fetches one page of candidates given the previous page's cursor (`null` for the first page). It is
 * injected into {@link discoverCandidates} so the pagination + row parsing is unit-testable without a
 * network; the runtime adapter that actually calls the endpoint is {@link createApiCandidateSource}.
 */
export type FetchCandidatePage = FetchPage<unknown>

// Per-request tuning: a short deadline. The retry policy lives in `@repo/utils` (see
// {@link fetchWithRetry}).
const REQUEST_TIMEOUT_MS = 5_000
/** The endpoint's maximum page size (it rejects anything larger with a 400). */
export const PAGE_LIMIT = 1000

/**
 * Hard cap on pages followed in one discovery pass — a runaway-cursor backstop, NOT an expected limit.
 * {@link PAGE_LIMIT} × this = 10,000 positions at or under the health-factor cutoff, far above any
 * realistic universe. Hitting it is logged loud (`discover.max_pages`) because silently truncating a
 * paginated candidate set is *under-inclusion* — a liquidatable position we would then never see
 * (over-inclusion is harmless; the onchain lens filters non-liquidatable pairs).
 */
const MAX_DISCOVERY_PAGES = 10

/**
 * Row-level companion to {@link MAX_DISCOVERY_PAGES}: a hard cap on candidates collected in one pass.
 * The page backstop bounds *pages*, but a server that ignores `limit` or the health-factor filter can
 * return the whole universe in one oversized page, which slips straight under a page-count cap.
 * Logged loud as `discover.oversized`.
 * Truncating here is safe (unlike the paginated case {@link MAX_DISCOVERY_PAGES} guards): the endpoint
 * orders by ascending health factor, so the retained candidates are the most-at-risk.
 */
const MAX_CANDIDATES = PAGE_LIMIT * MAX_DISCOVERY_PAGES

// Blue Market ids are always bytes32, so require the full 64 hex chars (stricter than bare isHex).
const MARKET_ID_RE = /^0x[0-9a-fA-F]{64}$/

// Validates and normalizes one raw response row into an id pair, or `null` if malformed. Only
// `market_id` + `borrower` are read — params come from `idToMarketParams(id)` and the lens re-reads
// all position state fresh onchain. The id is lowercased to match `marketId()` (keccak256 output) so
// map keys and log fields agree everywhere.
function parseCandidate(row: unknown): BorrowerId | null {
  if (typeof row !== 'object' || row === null) return null
  const { market_id: marketId, borrower } = row as { market_id?: unknown; borrower?: unknown }
  if (typeof marketId !== 'string' || !MARKET_ID_RE.test(marketId)) return null
  if (typeof borrower !== 'string' || !isAddress(borrower, { strict: false })) return null
  return { marketId: marketId.toLowerCase() as Hex, borrower: getAddress(borrower) }
}

/**
 * Walks the cursor-paginated candidate set: parse every row, de-dupe (market, borrower) pairs across
 * pages, and count malformed rows for the caller's drop diagnostics. Stops when the cursor runs out,
 * at the {@link MAX_DISCOVERY_PAGES} page backstop, or at the {@link MAX_CANDIDATES} row cap (both
 * logged loud — see their docs). `complete` is false when a backstop cut the walk short, so nothing it
 * did not reach reads as gone. Not `collectPages` from `@repo/utils`: the row cap must stop the walk
 * before fetching another page, which a collect-then-cap walk cannot.
 */
export async function discoverBorrowerIds(
  fetchPage: FetchCandidatePage,
  deps: { logger: Logger; maxPages?: number; maxCandidates?: number }
): Promise<{ pairs: BorrowerId[]; rawRows: number; malformed: number; complete: boolean }> {
  const maxPages = deps.maxPages ?? MAX_DISCOVERY_PAGES
  const maxCandidates = deps.maxCandidates ?? MAX_CANDIDATES
  const seen = new Set<string>()
  const pairs: BorrowerId[] = []
  let rawRows = 0
  let malformed = 0
  let cursor: string | null = null
  let complete = true

  for (let pages = 0; ; ) {
    const page: CursorPage<unknown> = await fetchPage(cursor)
    pages += 1
    rawRows += page.data.length
    for (const row of page.data) {
      const candidate = parseCandidate(row)
      if (!candidate) {
        malformed += 1
        continue
      }
      const key = `${candidate.marketId}:${candidate.borrower}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push(candidate)
      if (pairs.length >= maxCandidates) break
    }
    if (pairs.length >= maxCandidates) {
      deps.logger.warn('discover.oversized', {
        cap: maxCandidates,
        collected: pairs.length,
        rawRows
      })
      complete = false
      break
    }
    cursor = page.cursor
    if (!cursor) break
    if (pages >= maxPages) {
      deps.logger.warn('discover.max_pages', { pages, cap: maxPages, collected: pairs.length })
      complete = false
      break
    }
  }

  return { pairs, rawRows, malformed, complete }
}

/**
 * Reads the full over-inclusive (market, borrower) candidate universe from the candidates API and joins
 * it to onchain `MarketParams` via the injected resolver. Ids that don't resolve on THIS chain's
 * singleton are dropped — the backstop against an API/deployment mismatch (e.g. Robinhood's
 * non-canonical singleton). Malformed rows and unresolved ids never vanish silently: the resolver
 * uses `allowFailure`, so without the `discover.dropped` warn a schema change or a wrong singleton
 * would read as "0 candidates" with no error anywhere. A malformed row is a pair it could not read,
 * so the walk is no longer `complete`; an unresolved id is not, since a resolved one is cached for
 * good and an id that never resolved never held a position.
 */
export async function discoverCandidates(
  fetchPage: FetchCandidatePage,
  resolveParams: MarketParamsResolver,
  deps: { logger: Logger; maxPages?: number; maxCandidates?: number }
): Promise<{ candidates: BorrowerCandidate[]; complete: boolean }> {
  const { pairs, rawRows, malformed, complete } = await discoverBorrowerIds(fetchPage, deps)
  const marketIds = [...new Set(pairs.map(pair => pair.marketId))]
  const resolved = await resolveParams(marketIds)
  const unresolved = marketIds.filter(id => !resolved.has(id))

  const candidates: BorrowerCandidate[] = []
  for (const pair of pairs) {
    const marketParams = resolved.get(pair.marketId)
    if (marketParams) candidates.push({ marketParams, borrower: pair.borrower })
  }

  deps.logger.debug('discover.pass', {
    rawRows,
    malformed,
    pairs: pairs.length,
    markets: marketIds.length,
    unresolvedMarkets: unresolved.length,
    candidates: candidates.length
  })
  if (malformed > 0 || unresolved.length > 0) {
    deps.logger.warn('discover.dropped', {
      malformed,
      unresolvedMarkets: unresolved.length,
      // A bounded sample so a wrong-singleton or API-schema drift is diagnosable from one log line.
      unresolvedSample: unresolved.slice(0, 3)
    })
  }

  return { candidates, complete: complete && malformed === 0 }
}

/** The `fetch` shape the candidates source calls — injectable for tests. */
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

// Validated after `fetchWithRetry` so schema failures are not retried. Only `null` ends the walk: a
// missing or empty cursor throws rather than silently truncating it.
function parsePage(body: unknown): CursorPage<unknown> {
  const { data, cursor } = (body ?? {}) as { data?: unknown; cursor?: unknown }
  if (!Array.isArray(data)) throw new CandidatesApiResponseError('missing data')
  if (cursor !== null && typeof cursor !== 'string') {
    throw new CandidatesApiResponseError('missing cursor')
  }
  if (cursor === '') throw new CandidatesApiResponseError('empty cursor')
  return { data, cursor }
}

/**
 * A {@link FetchCandidatePage} over the Morpho API's blue liquidation-candidates endpoint, retried per
 * {@link fetchWithRetry}. Throws {@link CandidatesApiRefusedError} on a 3xx or a 4xx other than 429.
 */
export function createApiCandidateSource(deps: {
  url: string
  apiKey: string
  chainId: number
  healthFactorLte: number
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
}): FetchCandidatePage {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? delay
  const label = 'liquidation-candidates'

  return async cursor => {
    const url = new URL(deps.url)
    url.searchParams.set('chain_ids', String(deps.chainId))
    url.searchParams.set('health_factor_lte', String(deps.healthFactorLte))
    url.searchParams.set('limit', String(PAGE_LIMIT))
    if (cursor) url.searchParams.set('cursor', cursor)

    let status: number | undefined
    const body = await tryCatch(
      fetchWithRetry(
        async () => {
          const response = await fetchImpl(url.toString(), {
            headers: { 'x-api-key': deps.apiKey },
            // fetch strips only `Authorization` on a cross-origin redirect, so following one could leak
            // the key: https://fetch.spec.whatwg.org/#http-redirect-fetch
            redirect: 'manual',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          })
          status = response.status
          // Parse defensively INSIDE the callback so a non-JSON 5xx body still reaches the HTTP
          // status/Retry-After policy (an `undefined` data on a 2xx throws "parse error" instead).
          const parsed = await tryCatch(response.json())
          return { data: parsed.error ? undefined : (parsed.data ?? undefined), response }
        },
        { label, sleep }
      )
    )
    if (body.error) {
      if (status !== undefined && status >= 300 && status < 500 && status !== 429) {
        throw new CandidatesApiRefusedError(status)
      }
      throw body.error
    }
    return parsePage(body.data)
  }
}
