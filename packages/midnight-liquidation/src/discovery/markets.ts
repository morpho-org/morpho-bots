import type { Logger } from '@repo/bot-kit'
import type { Address, Hex } from 'viem'

import {
  backoffMs,
  delay,
  ensureError,
  parseJsonResponse,
  retryAfterMs,
  tryCatch
} from '@repo/utils'
import { isAddress, isHex } from 'viem'

// Pure response shapes from `GET /v0/midnight/markets` (the seed script imports these too). Only the
// fields the whitelist needs are modeled; the API returns more (maturity, fees, …) that we ignore.
export type ApiCollateral = {
  token: Address
  lltv: string
  liquidation_cursor: string
  oracle: Address
}
export type ApiMarket = {
  chain_id: number
  market_id: Hex
  loan_token: Address
  collaterals: ApiCollateral[]
}

/**
 * The market whitelist: `GET /v0/midnight/markets?listed=true` defines the set of markets the bot is
 * allowed to touch. `isListed` gates borrower candidates before the lens read, probing, and
 * liquidation — a market not in the listed set is never acted on (fail-closed). The set is refreshed
 * on a timer and serves last-known-good on a transient API failure, so a blip never silently widens
 * or empties the whitelist mid-flight; only a never-successful first fetch yields an empty set (safe).
 */
type ListedMarketFilter = {
  isListed: (marketId: Hex) => boolean
  refresh: () => Promise<void>
  snapshot: () => { markets: number; updatedAt: number | null }
  /** Restorable snapshot of the whitelist; `updatedAt` lets the caller decide staleness. */
  dump: () => ListedMarketsState
}

/**
 * Restorable whitelist state: what `dump()` emits and `initialState` accepts. `updatedAt` is the
 * caller's staleness signal — a restored-but-old whitelist must be refreshed (and treated as empty
 * past a fail-closed max-age) rather than served forever, or a delisted market would stay in scope.
 */
export type ListedMarketsState = { marketIds: string[]; updatedAt: number | null }

/** Minimal `fetch` shape the source calls — the global `fetch` satisfies it; test fakes need not. */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const REQUEST_TIMEOUT_MS = 5_000
const MAX_REQUEST_RETRIES = 3

/**
 * Builds the {@link ListedMarketFilter}. Mirrors `discovery/borrowers.ts`'s HTTP conventions (direct
 * `fetch`, retry 429/5xx/network with `Retry-After`, {@link REQUEST_TIMEOUT_MS} deadline) — this
 * endpoint is Morpho's own (not a rate-limited venue), so a small self-contained client suffices.
 * `fetchImpl`/`sleep`/`now` are injectable for tests.
 */
export function createListedMarketFilter(deps: {
  apiUrl: string
  chainId: number
  logger: Logger
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Seeds the whitelist from a prior `dump()`; the caller owns the staleness policy. */
  initialState?: ListedMarketsState
}): ListedMarketFilter {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? delay
  const now = deps.now ?? (() => Date.now())

  // Last-known-good: only replaced by a fully-successful refresh, so a transient failure keeps serving
  // the prior set rather than emptying the whitelist.
  let listed = new Set<string>(deps.initialState?.marketIds ?? [])
  let updatedAt: number | null = deps.initialState?.updatedAt ?? null

  async function fetchListed(): Promise<ApiMarket[]> {
    const url = new URL(deps.apiUrl)
    url.searchParams.set('listed', 'true')

    for (let attempt = 0; ; attempt++) {
      const { data: response, error: networkError } = await tryCatch(
        fetchImpl(url.toString(), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      )

      if (networkError) {
        if (attempt < MAX_REQUEST_RETRIES) {
          await sleep(backoffMs(attempt))
          continue
        }
        throw new Error(`markets request failed: ${ensureError(networkError).message}`)
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_REQUEST_RETRIES) {
          await sleep(retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt))
          continue
        }
        throw new Error(`markets HTTP ${response.status}`)
      }

      const { data, error: parseError } = await parseJsonResponse<{ data?: unknown }>(response)
      if (!response.ok) throw new Error(`markets HTTP ${response.status}`)
      if (parseError || !data) {
        throw new Error(`markets parse error: ${parseError?.message ?? 'empty body'}`)
      }
      return Array.isArray(data.data) ? (data.data as ApiMarket[]) : []
    }
  }

  async function refresh(): Promise<void> {
    const rows = await fetchListed()
    const next = new Set<string>()
    for (const market of rows) {
      if (market.chain_id !== deps.chainId) continue
      if (typeof market.market_id !== 'string' || !isHex(market.market_id)) continue
      if (!isAddress(market.loan_token, { strict: false })) continue
      next.add(market.market_id.toLowerCase())
    }
    listed = next
    updatedAt = now()
    deps.logger.info('markets.listed', { chainId: deps.chainId, markets: listed.size })
  }

  return {
    isListed: marketId => listed.has(marketId.toLowerCase()),
    refresh,
    snapshot: () => ({ markets: listed.size, updatedAt }),
    dump: () => ({ marketIds: [...listed], updatedAt })
  }
}
