import type { Logger } from '@repo/bot-kit';
import { delay, fetchWithRetry, tryCatch } from '@repo/utils';

import type { Address, Hex } from 'viem';
import { getAddress, isAddress } from 'viem';

import type { MarketParams } from '../market';
import type { MarketParamsResolver } from '../state/market-params';

/** A discovered (market id, borrower) pair from the GraphQL API, before params are resolved. */
type BorrowerId = { marketId: Hex; borrower: Address };

/** A candidate position to evaluate: a (market, borrower) pair, with the market's immutable params
 * resolved on-chain via `idToMarketParams(id)` (see ../state/market-params.ts). */
export type BorrowerCandidate = { marketParams: MarketParams; borrower: Address };

/** One page of the skip-paginated `marketPositions` response: raw rows plus the server's total. */
export type PositionPage = { items: readonly unknown[]; countTotal: number | null };

/**
 * Fetches one page of positions at the given `skip` offset. It is injected into
 * {@link discoverCandidates} so the pagination + row parsing is unit-testable without a network; the
 * runtime adapter that actually calls the endpoint is {@link createGraphqlCandidateSource}.
 */
export type FetchPositionPage = (skip: number) => Promise<PositionPage>;

// Per-request tuning: a short deadline. The retry policy lives in `@repo/utils` (see
// {@link fetchWithRetry}).
const REQUEST_TIMEOUT_MS = 5_000;
/** The API's maximum page size — also the pagination loop's partial-page signal, so the fetcher and
 * the loop must agree on it (which is why {@link createGraphqlCandidateSource} takes no override). */
export const PAGE_LIMIT = 1000;

/**
 * Hard cap on pages followed in one discovery pass — a runaway backstop, NOT an expected limit.
 * {@link PAGE_LIMIT} × this = 10,000 positions at or under the health-factor cutoff, far above any
 * realistic universe. Hitting it is logged loud (`discover.max_pages`) because silently truncating a
 * paginated candidate set is *under-inclusion* — a liquidatable position we would then never see
 * (over-inclusion is harmless; the on-chain lens filters non-liquidatable pairs).
 */
const MAX_DISCOVERY_PAGES = 10;

/**
 * Row-level companion to {@link MAX_DISCOVERY_PAGES}: a hard cap on candidates collected in one pass.
 * The page backstop bounds *pages*, but the API can return the whole universe in a single oversized
 * page (observed: ~135k rows when the `healthFactor_lte` filter never reaches the server), which slips
 * straight under a page-count cap. Reaching this many candidates under a health-factor cutoff means
 * the filter almost certainly isn't narrowing — logged loud as `discover.oversized` so it's alertable.
 * Truncating here is safe (unlike the paginated case {@link MAX_DISCOVERY_PAGES} guards): the query
 * orders by ascending health factor, so the retained candidates are the most-at-risk, and the on-chain
 * lens still filters the rest. Kept equal to the page ceiling so both backstops bound the same volume.
 */
const MAX_CANDIDATES = PAGE_LIMIT * MAX_DISCOVERY_PAGES;

/**
 * The `marketPositions` query: only listed markets, only positions at or below the health-factor
 * cutoff, scoped to this bot's chain server-side. Ascending health-factor order puts the worst
 * positions on page 1, so even a pathological truncation degrades gracefully. Only
 * `market.marketId` + `user.address` are consumed — the market's params are recovered on-chain from
 * `idToMarketParams(id)` and the lens re-reads all position state fresh, so the API is a coverage
 * source, never a correctness dependency.
 */
const MARKET_POSITIONS_QUERY = `
  query MarketPositions($chainIds: [Int!], $hfLte: Float!, $first: Int!, $skip: Int!) {
    marketPositions(
      where: { chainId_in: $chainIds, healthFactor_lte: $hfLte, marketListed: true }
      orderBy: HealthFactor
      orderDirection: Asc
      first: $first
      skip: $skip
    ) {
      pageInfo { count countTotal }
      items { market { marketId } user { address } }
    }
  }
`;

// Blue market ids are always bytes32, so require the full 64 hex chars (stricter than bare isHex).
const MARKET_ID_RE = /^0x[0-9a-fA-F]{64}$/;

// Validates and normalizes one raw response row into an id pair, or `null` if malformed. The id is
// lowercased to match `marketId()` (keccak256 output) so map keys and log fields agree everywhere.
function parseCandidate(row: unknown): BorrowerId | null {
  if (typeof row !== 'object' || row === null) {
    return null;
  }
  const { market, user } = row as { market?: unknown; user?: unknown };
  if (typeof market !== 'object' || market === null) {
    return null;
  }
  if (typeof user !== 'object' || user === null) {
    return null;
  }
  const { marketId } = market as { marketId?: unknown };
  const { address } = user as { address?: unknown };
  if (typeof marketId !== 'string' || !MARKET_ID_RE.test(marketId)) {
    return null;
  }
  if (typeof address !== 'string' || !isAddress(address, { strict: false })) {
    return null;
  }
  return { marketId: marketId.toLowerCase() as Hex, borrower: getAddress(address) };
}

/**
 * Walks the skip-paginated position set: parse every row, de-dupe (market, borrower) pairs across
 * pages, and count malformed rows for the caller's drop diagnostics. Stops on a partial page, on
 * reaching the server-reported total, at the {@link MAX_DISCOVERY_PAGES} page backstop, or at the
 * {@link MAX_CANDIDATES} row cap (both logged loud — see their docs). Note skip-pagination can shift
 * under concurrent updates; the de-dupe absorbs
 * duplicates and a transiently missed row reappears next tick.
 */
export async function discoverBorrowerIds(
  fetchPage: FetchPositionPage,
  deps: { logger: Logger; maxPages?: number; maxCandidates?: number }
): Promise<{ pairs: BorrowerId[]; rawRows: number; malformed: number }> {
  const maxPages = deps.maxPages ?? MAX_DISCOVERY_PAGES;
  const maxCandidates = deps.maxCandidates ?? MAX_CANDIDATES;
  const seen = new Set<string>();
  const pairs: BorrowerId[] = [];
  let rawRows = 0;
  let malformed = 0;
  let skip = 0;

  for (let pages = 0; ; ) {
    const page = await fetchPage(skip);
    pages += 1;
    rawRows += page.items.length;
    for (const row of page.items) {
      const candidate = parseCandidate(row);
      if (!candidate) {
        malformed += 1;
        continue;
      }
      const key = `${candidate.marketId}:${candidate.borrower}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      pairs.push(candidate);
      if (pairs.length >= maxCandidates) {
        break;
      }
    }
    // Row-level runaway backstop — truncate an oversized result and log loud; see MAX_CANDIDATES.
    if (pairs.length >= maxCandidates) {
      deps.logger.warn('discover.oversized', {
        cap: maxCandidates,
        collected: pairs.length,
        rawRows
      });
      break;
    }
    skip += page.items.length;
    const exhausted =
      page.items.length < PAGE_LIMIT || (page.countTotal !== null && skip >= page.countTotal);
    if (exhausted) {
      break;
    }
    if (pages >= maxPages) {
      deps.logger.warn('discover.max_pages', { pages, cap: maxPages, collected: pairs.length });
      break;
    }
  }

  return { pairs, rawRows, malformed };
}

/**
 * Reads the full over-inclusive (market, borrower) candidate universe from the GraphQL API and joins
 * it to on-chain `MarketParams` via the injected resolver. Ids that don't resolve on THIS chain's
 * singleton are dropped — the backstop against an API/deployment mismatch (e.g. Robinhood's
 * non-canonical singleton). Malformed rows and unresolved ids never vanish silently: the resolver
 * uses `allowFailure`, so without the `discover.dropped` warn a schema change or a wrong singleton
 * would read as "0 candidates" with no error anywhere.
 */
export async function discoverCandidates(
  fetchPage: FetchPositionPage,
  resolveParams: MarketParamsResolver,
  deps: { logger: Logger; maxPages?: number; maxCandidates?: number }
): Promise<BorrowerCandidate[]> {
  const { pairs, rawRows, malformed } = await discoverBorrowerIds(fetchPage, deps);
  const marketIds = [...new Set(pairs.map(pair => pair.marketId))];
  const resolved = await resolveParams(marketIds);
  const unresolved = marketIds.filter(id => !resolved.has(id));

  const candidates: BorrowerCandidate[] = [];
  for (const pair of pairs) {
    const marketParams = resolved.get(pair.marketId);
    if (marketParams) {
      candidates.push({ marketParams, borrower: pair.borrower });
    }
  }

  deps.logger.debug('discover.pass', {
    rawRows,
    malformed,
    pairs: pairs.length,
    markets: marketIds.length,
    unresolvedMarkets: unresolved.length,
    candidates: candidates.length
  });
  if (malformed > 0 || unresolved.length > 0) {
    deps.logger.warn('discover.dropped', {
      malformed,
      unresolvedMarkets: unresolved.length,
      // A bounded sample so a wrong-singleton or API-schema drift is diagnosable from one log line.
      unresolvedSample: unresolved.slice(0, 3)
    });
  }

  return candidates;
}

/** The `fetch` shape the GraphQL source calls — injectable for tests. */
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// Narrows the GraphQL envelope AFTER the retry loop: a 2xx body with an `errors` array or a shape we
// don't recognize is a request/schema-level failure, not a transient one — retrying the identical
// document cannot help, so these throw outside `fetchWithRetry` (whose callback treats every throw
// as a retryable network failure).
function parsePage(body: unknown, label: string): PositionPage {
  const { errors, data } = (body ?? {}) as { errors?: unknown; data?: unknown };
  if (Array.isArray(errors) && errors.length > 0) {
    const { message } = (errors[0] ?? {}) as { message?: unknown };
    const detail = typeof message === 'string' ? message : JSON.stringify(errors[0]);
    throw new Error(`${label} GraphQL error: ${detail}`);
  }
  const { marketPositions } = (data ?? {}) as { marketPositions?: unknown };
  const { items, pageInfo } = (marketPositions ?? {}) as { items?: unknown; pageInfo?: unknown };
  if (!Array.isArray(items)) {
    throw new Error(`${label} parse error: missing items`);
  }
  const { count, countTotal } = (pageInfo ?? {}) as { count?: unknown; countTotal?: unknown };
  // The server's own row count disagreeing with the page it sent is exactly the kind of quiet
  // truncation discovery must never absorb silently.
  if (typeof count === 'number' && count !== items.length) {
    throw new Error(`${label} parse error: pageInfo.count ${count} != items ${items.length}`);
  }
  return { items, countTotal: typeof countTotal === 'number' ? countTotal : null };
}

/**
 * Runtime adapter: a {@link FetchPositionPage} backed by the Morpho GraphQL API via a plain `fetch`
 * POST (a static document + variables needs no GraphQL client, and a client would do no runtime
 * validation anyway). The retry callback ONLY fetches and defensively parses JSON — 429/5xx/network
 * retries (honoring `Retry-After`) happen in {@link fetchWithRetry}, and the GraphQL envelope is
 * validated after it via {@link parsePage} so request-level failures are never retried. A
 * non-retryable failure throws; the caller catches it (logs `discover.error`) and proceeds so the
 * pending queue is still driven that block. `fetchImpl`/`sleep` are injectable for tests.
 */
export function createGraphqlCandidateSource(deps: {
  url: string;
  chainId: number;
  healthFactorLte: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}): FetchPositionPage {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? delay;
  const label = 'market-positions';

  return async skip => {
    const body = await fetchWithRetry(
      async () => {
        const response = await fetchImpl(deps.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: MARKET_POSITIONS_QUERY,
            variables: {
              chainIds: [deps.chainId],
              hfLte: deps.healthFactorLte,
              first: PAGE_LIMIT,
              skip
            }
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        // Parse defensively INSIDE the callback so a non-JSON 5xx body still reaches the HTTP
        // status/Retry-After policy (an `undefined` data on a 2xx throws "parse error" instead).
        const parsed = await tryCatch(response.json());
        return { data: parsed.error ? undefined : (parsed.data ?? undefined), response };
      },
      { label, sleep }
    );
    return parsePage(body, label);
  };
}
