import type { Address } from 'viem'

import { getAddress, isAddress, isAddressEqual, isHex } from 'viem'

import type { RateLimitedClient } from '../http-client'
import type { QuoteLogger } from '../quoting'
import type { Unwrapper } from './resolve'

import {
  BPS,
  DEFAULT_PENDLE_SLIPPAGE_BPS,
  PENDLE_BASE_URL,
  PENDLE_MARKETS_STALE_MS
} from '../constants'
import { QuoteError } from '../types'

/** One usable market from Pendle's list: everything PT detection + conversion needs. */
type PendleMarket = {
  pt: Address
  yt: Address
  /** The market contract, path segment of the active-PT swap endpoint. */
  market: Address
  /** ISO expiry — decides redeem (expired) vs swap (active). Validated parseable at ingest. */
  expiry: string
  underlying: Address
}

/** The TTL-cached markets list: when it was fetched and the usable markets it yielded. */
type PendleMarketsState = { fetchedAt: number; markets: PendleMarket[] }

// Response subsets we consume. Markets carry addresses as "{chainId}-{address}" strings.
type MarketsResponse = {
  markets?: {
    address?: string
    pt?: string
    yt?: string
    underlyingAsset?: string
    expiry?: string
  }[]
}
type ConvertResponse = {
  tx?: { to?: string; data?: string; value?: string }
  data?: { amountOut?: string }
}

// Pendle encodes token references as "{chainId}-{address}" (the market's own `address` is plain);
// accept either shape by taking the last '-'-separated segment.
function parsePrefixedAddress(value: string | undefined): Address | null {
  const raw = value?.split('-').at(-1)
  return raw !== undefined && isAddress(raw, { strict: false }) ? getAddress(raw) : null
}

/**
 * Detects Pendle Principal Tokens and converts them into a Router step to their underlying:
 * expired PTs redeem (deterministic), active PTs swap through the Pendle AMM. Both come as hosted-SDK
 * calldata that binds a FIXED input amount (approx params + limit orders inside — never spliceable,
 * never cacheable) and pulls the PT via `transferFrom`, so the step carries the router as its
 * `approvalSpender`.
 *
 * Detection is a per-chain markets list (`/v1/markets/all`), TTL-cached in the closure.
 * **Only successful responses are cached** — a fetch failure with
 * stale data falls back to the stale list (warn), and with NO data it throws (→ `failed` +
 * cooldown): "couldn't determine" must never persist as "confirmed not a PT", or one outage would
 * suppress PT liquidations for the whole TTL. Construct this unwrapper only on `PENDLE_CHAIN_IDS` —
 * on other chains a cold-cache fetch failure would fail plain-collateral quotes too.
 *
 * The reported `amountOut` is Pendle's expected output; the tx enforces a slippage-bounded floor we
 * don't receive verbatim, so `amountOutMinimum` is the conservative estimate
 * `amountOut × (1 − slippage)` — sizing the downstream sell so a shortfall is not expected, with
 * `simulate()` as the real guarantee and the intermediate skim sweeping the surplus.
 */
export function createPendlePtUnwrapper(deps: {
  client: RateLimitedClient
  chainId: number
  slippageBps?: number
  /** Test seam only — production uses {@link PENDLE_BASE_URL}. */
  baseUrl?: string
  staleMs?: number
  logger: QuoteLogger
  now?: () => number
}): Unwrapper {
  const { client, chainId, logger } = deps
  const slippageBps = deps.slippageBps ?? DEFAULT_PENDLE_SLIPPAGE_BPS
  const baseUrl = deps.baseUrl ?? PENDLE_BASE_URL
  const staleMs = deps.staleMs ?? PENDLE_MARKETS_STALE_MS
  const now = deps.now ?? (() => Date.now())

  let cache: PendleMarketsState | null = null

  function parseMarkets(json: MarketsResponse): PendleMarket[] {
    const markets: PendleMarket[] = []
    for (const entry of json.markets ?? []) {
      const pt = parsePrefixedAddress(entry.pt)
      const yt = parsePrefixedAddress(entry.yt)
      const market = parsePrefixedAddress(entry.address)
      const underlying = parsePrefixedAddress(entry.underlyingAsset)
      // A malformed expiry would Date.parse to NaN, whose comparisons are all false — silently
      // classifying the PT as active. Drop the entry loudly instead.
      const expiryValid = entry.expiry !== undefined && !Number.isNaN(Date.parse(entry.expiry))
      if (!pt || !yt || !market || !underlying || !expiryValid) {
        logger.warn('pendle.market_malformed', { chainId, market: entry.address ?? null })
        continue
      }
      markets.push({ pt, yt, market, expiry: entry.expiry as string, underlying })
    }
    return markets
  }

  async function marketsFor(): Promise<PendleMarket[]> {
    if (cache && now() - cache.fetchedAt < staleMs) return cache.markets

    try {
      const json = await client.getJson<MarketsResponse>({
        venue: 'pendle',
        url: `${baseUrl}/v1/markets/all`,
        searchParams: { chainId: String(chainId) }
      })
      cache = { fetchedAt: now(), markets: parseMarkets(json) }
      return cache.markets
    } catch (error) {
      // Stale beats nothing: keep detecting PTs through an API outage on the last good list. The
      // stale cache is NOT re-stamped, so the next resolve retries the fetch.
      if (cache) {
        logger.warn('pendle.markets_stale', {
          chainId,
          fetchedAt: cache.fetchedAt,
          detail: error instanceof Error ? error.message : String(error)
        })
        return cache.markets
      }
      throw error instanceof QuoteError
        ? error
        : new QuoteError(
            'api_error',
            `pendle markets fetch failed: ${error instanceof Error ? error.message : String(error)}`
          )
    }
  }

  return {
    kind: 'pendle-pt',
    async resolve({ token, amountIn, executor }) {
      const markets = await marketsFor()
      const market = markets.find(entry => isAddressEqual(entry.pt, token))
      if (!market) return null

      const expired = Date.parse(market.expiry) <= now()
      // `slippage` is a decimal fraction. `enableAggregator=false` keeps the expired-PT redeem a
      // pure deterministic conversion to the native underlying (deliberate divergence from
      // upstream's `true`): our own venues sell the underlying, and if it is itself a vault share,
      // the resolve loop unwraps it at the next depth level.
      const json = expired
        ? await client.getJson<ConvertResponse>({
            venue: 'pendle',
            url: `${baseUrl}/v2/sdk/${chainId}/redeem`,
            searchParams: {
              receiver: executor,
              slippage: (slippageBps / Number(BPS)).toString(),
              yt: market.yt,
              amountIn: amountIn.toString(),
              tokenOut: market.underlying,
              enableAggregator: 'false'
            }
          })
        : await client.getJson<ConvertResponse>({
            venue: 'pendle',
            url: `${baseUrl}/v2/sdk/${chainId}/markets/${market.market}/swap`,
            searchParams: {
              receiver: executor,
              slippage: (slippageBps / Number(BPS)).toString(),
              tokenIn: token,
              tokenOut: market.underlying,
              amountIn: amountIn.toString()
            }
          })

      const to = json.tx?.to
      const data = json.tx?.data
      const amountOut = json.data?.amountOut
      if (!to || !isAddress(to, { strict: false }) || !data || !isHex(data)) {
        throw new QuoteError('api_error', `pendle: malformed ${expired ? 'redeem' : 'swap'} tx`)
      }
      if (amountOut === undefined || !/^\d+$/.test(amountOut)) {
        throw new QuoteError('api_error', 'pendle: malformed amountOut')
      }

      const expectedAmountOut = BigInt(amountOut)
      return {
        step: {
          tokenIn: token,
          tokenOut: market.underlying,
          target: getAddress(to),
          value: BigInt(json.tx?.value ?? 0),
          callData: data,
          // Route-bound calldata (approx params, limit orders) — commit the amount, never splice.
          amountIn: { source: 'fixed', value: amountIn },
          // The Router pulls the PT via transferFrom.
          approvalSpender: getAddress(to)
        },
        expectedAmountOut,
        amountOutMinimum: (expectedAmountOut * (BPS - BigInt(slippageBps))) / BPS
      }
    }
  }
}
