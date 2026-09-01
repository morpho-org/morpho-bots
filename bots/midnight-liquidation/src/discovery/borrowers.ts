import type { Logger } from '@repo/bot-kit'
import type { Address, Hex } from 'viem'

import { delay, fetchWithRetry } from '@repo/utils'
import createClient from 'openapi-fetch'
import { getAddress, isAddress, isHex } from 'viem'

import type { paths } from '../generated/markets-api'

import { collectPages } from './paginate.utils'

/** A candidate position to evaluate: a (market, borrower) pair the API flagged as at-risk. */
export type BorrowerCandidate = { marketId: Hex; borrower: Address }

/** One page of the cursor-paginated liquidation-candidates response: the raw rows plus the cursor. */
export type CandidatePage = { cursor: string | null; data: readonly unknown[] }

/**
 * Fetches one page of candidates given the previous page's cursor (`null` for the first page). It is
 * injected into {@link discoverBorrowers} so the pagination + row parsing is unit-testable without a
 * network; the runtime adapter that actually calls the endpoint is {@link createApiCandidateSource}.
 */
export type FetchCandidatePage = (cursor: string | null) => Promise<CandidatePage>

// Per-request tuning for the candidates endpoint: a short deadline. The retry policy lives in
// `@repo/utils` (see {@link fetchWithRetry}).
const REQUEST_TIMEOUT_MS = 5_000
/** The endpoint's maximum page size — fewer round-trips than the default 20. */
const PAGE_LIMIT = 100

/**
 * Hard cap on pages followed in one discovery pass — a runaway-cursor backstop, NOT an expected
 * limit. {@link PAGE_LIMIT} × this = 10,000 candidates, far above any realistic Midnight universe.
 * Hitting it is logged loud (`discover.max_pages`) because silently truncating a paginated candidate
 * set is *under-inclusion* — a liquidatable position we would then never see (over-inclusion is
 * harmless; the on-chain lens filters non-liquidatable pairs).
 */
export const MAX_DISCOVERY_PAGES = 100

/**
 * The candidates operation path — a literal key of the generated {@link paths}, so `client.GET(LIQUIDATION_CANDIDATES_PATH)`
 * is type-checked against the spec. The runtime base URL is derived by stripping this suffix from the
 * configured endpoint URL (see {@link createApiCandidateSource}).
 *
 * Exported because `LIQUIDATION_CANDIDATES_API_URL` is the base for the sibling tokens endpoint too:
 * that suffix, not the tokens one, is what the configured URL ends with, so stripping it is the only
 * way to recover a gateway prefix (see `createTokenPriceSource`).
 */
export const LIQUIDATION_CANDIDATES_PATH = '/markets/midnight/liquidation-candidates'

// Validates and normalizes one raw response row into a candidate, or `null` if malformed. Only
// `market_id` + `borrower` feed the pipeline — the lens re-derives everything else (debt, health,
// gates, maturity) fresh on-chain — so the rest of the row is intentionally ignored.
function parseCandidate(row: unknown): BorrowerCandidate | null {
  if (typeof row !== 'object' || row === null) return null
  const { market_id: marketId, borrower } = row as { market_id?: unknown; borrower?: unknown }
  if (
    typeof marketId === 'string' &&
    isHex(marketId) &&
    typeof borrower === 'string' &&
    isAddress(borrower, { strict: false })
  ) {
    return { marketId, borrower: getAddress(borrower) }
  }
  return null
}

/**
 * Reads the full over-inclusive (market, borrower) candidate universe from the liquidation-candidates
 * endpoint, following the cursor across every page. The page fetcher is injected so this parsing is
 * unit-testable without a live endpoint; the runtime adapter is {@link createApiCandidateSource}.
 * Malformed rows are skipped and (market, borrower) pairs are de-duplicated across pages. Over-
 * inclusion is harmless — the on-chain lens drops non-liquidatable pairs — but a truncated page walk
 * would be under-inclusion, so the {@link MAX_DISCOVERY_PAGES} backstop logs loud rather than
 * silently stopping.
 */
export async function discoverBorrowers(
  fetchPage: FetchCandidatePage,
  deps: { logger: Logger; maxPages?: number }
): Promise<BorrowerCandidate[]> {
  const rows = await collectPages(fetchPage, {
    logger: deps.logger,
    maxPages: deps.maxPages ?? MAX_DISCOVERY_PAGES,
    event: 'discover.max_pages'
  })

  const seen = new Set<string>()
  const candidates: BorrowerCandidate[] = []
  for (const row of rows) {
    const candidate = parseCandidate(row)
    if (!candidate) continue
    const key = `${candidate.marketId}:${candidate.borrower}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
  }

  return candidates
}

/** The `fetch` shape `openapi-fetch` calls — a single `Request`. The global `fetch` satisfies it. */
type FetchLike = (request: Request) => Promise<Response>

/**
 * Runtime adapter: a {@link FetchCandidatePage} backed by the liquidation-candidates HTTP endpoint,
 * via a typed `openapi-fetch` client generated from the Markets Internal API spec. `openapi-fetch`
 * builds the URL, serializes the query, and parses/types the body; this wrapper keeps the bespoke
 * retry policy it does NOT provide via {@link fetchWithRetry} (429/5xx/network, honoring
 * `Retry-After`), with a per-request {@link REQUEST_TIMEOUT_MS} deadline. `client.GET` resolves on
 * 4xx/5xx (it only throws on network/abort), so `response.status`/`Retry-After` stay reachable. A
 * non-retryable failure throws; the caller catches it (logs `discover.error`) and proceeds so the
 * pending queue is still driven that block. `fetchImpl`/`sleep` are injectable for tests.
 *
 * `deps.url` is the fully-qualified endpoint URL from config; the client base URL is it minus the
 * fixed {@link LIQUIDATION_CANDIDATES_PATH} suffix (falling back to the origin). An operator override of
 * `LIQUIDATION_CANDIDATES_API_URL` therefore changes host/prefix, but the request path is fixed by
 * the typed client.
 */
export function createApiCandidateSource(deps: {
  url: string
  chainId: number
  healthFactorLte: number
  limit?: number
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
}): FetchCandidatePage {
  const sleep = deps.sleep ?? delay
  const baseUrl = deps.url.endsWith(LIQUIDATION_CANDIDATES_PATH)
    ? deps.url.slice(0, -LIQUIDATION_CANDIDATES_PATH.length)
    : new URL(deps.url).origin
  const client = createClient<paths>({ baseUrl, fetch: deps.fetchImpl ?? fetch })

  return async cursor => {
    const body = await fetchWithRetry(
      () =>
        client.GET(LIQUIDATION_CANDIDATES_PATH, {
          params: {
            query: {
              chain_ids: [deps.chainId],
              health_factor_lte: deps.healthFactorLte,
              // `include_matured` is always sent: a matured market is liquidatable regardless of
              // health factor and the on-chain gate liquidates on maturity, so those positions must
              // be in the candidate set even when their health factor sits above `healthFactorLte`.
              include_matured: 'true',
              limit: deps.limit ?? PAGE_LIMIT,
              ...(cursor ? { cursor } : {})
            }
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        }),
      { label: 'liquidation-candidates', sleep }
    )

    const nextCursor =
      typeof body.cursor === 'string' && body.cursor.length > 0 ? body.cursor : null
    const rows = Array.isArray(body.data) ? body.data : []
    return { cursor: nextCursor, data: rows }
  }
}
