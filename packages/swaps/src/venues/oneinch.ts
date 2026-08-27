import { getAddress, isAddressEqual, isHex } from 'viem'

import type { RateLimitedClient } from '../http-client'
import type { PriceParameters, PriceQuote, QuoteParameters, Swap } from '../types'

import { ONEINCH_BASE_URL, ONEINCH_ROUTER } from '../constants'
import { QuoteError } from '../types'

/** The 1inch arm of the per-collateral swap config. */
type OneInchEntry = { baseUrl?: string }

// Subset of the 1inch Classic Swap v6 `/swap` response we consume.
type OneInchSwap = {
  dstAmount?: string
  tx?: { to?: string; data?: string; value?: string }
}

/**
 * Quotes 1inch via the one-step Classic Swap `/swap` endpoint, which returns ready-to-use `tx`
 * calldata. Approval is a plain ERC20 `approve` to the static AggregationRouterV6 (no Permit2). Output
 * is sent to `receiver` (the Executor). `slippage` is a percentage (bps / 100). `amount` is committed
 * off-chain, so the {@link Swap} carries `amountIn: { source: 'fixed' }`; the on-chain min-out is the
 * router's own bound (we record an oracle-derived floor for observability).
 */
export async function quoteOneInch(
  client: RateLimitedClient,
  entry: OneInchEntry,
  params: QuoteParameters
): Promise<Swap> {
  const router = ONEINCH_ROUTER[params.chainId]
  if (!router)
    throw new QuoteError('api_error', `1inch: no router configured for chain ${params.chainId}`)

  const json = await client.getJson<OneInchSwap>({
    venue: '1inch',
    url: `${entry.baseUrl ?? ONEINCH_BASE_URL}/swap/v6.1/${params.chainId}/swap`,
    searchParams: {
      src: params.tokenIn,
      dst: params.tokenOut,
      amount: params.amountIn.toString(),
      from: params.executor,
      origin: params.executor,
      receiver: params.executor,
      // `minReturn` is an ABSOLUTE base-unit minimum, unlike `slippage` which is a percentage the API
      // applies to its own quote. Asking for the absolute floor is what lets the returned bound be
      // reported faithfully rather than reconstructed — see {@link Swap.minOutSource}.
      minReturn: params.minAcceptableAmountOut.toString(),
      disableEstimate: 'true'
    }
  })

  if (!json.tx?.to || !json.tx.data) {
    throw new QuoteError('no_route', '1inch: no route for this pair/size')
  }
  if (!isHex(json.tx.data)) {
    throw new QuoteError('api_error', '1inch: tx.data is not hex')
  }

  // Pin the swap target to the statically-known AggregationRouterV6 for this chain. `tx.to` is
  // otherwise trusted verbatim, so a compromised/misdirected API response could point the swap — and
  // the token approval — at an arbitrary contract. `spender` is ALREADY the static `router` (never
  // read from the response), and 1inch's contract semantics make `tx.to === spender`; asserting
  // `tx.to === router` keeps the call target and the approval in lockstep on the same known contract.
  // A mismatch is treated as any other invalid 1inch response: throw `QuoteError`, which the quoting
  // layer catches and logs as `quote.failed` with both addresses in `detail` (fail the quote loudly,
  // never past the venue seam).
  const target = getAddress(json.tx.to)
  if (!isAddressEqual(target, router)) {
    throw new QuoteError(
      'api_error',
      `1inch: tx.to ${target} does not match the configured router ${router}`
    )
  }

  const expectedAmountOut = BigInt(json.dstAmount ?? '0')
  return {
    spender: router,
    target,
    value: BigInt(json.tx.value ?? '0'),
    callData: json.tx.data,
    amountIn: { source: 'fixed', value: params.amountIn },
    expectedAmountOut,
    // The absolute `minReturn` we asked for, which the router enforces — the same trust boundary as
    // 0x's `minBuyAmount` or LiFi's `toAmountMin`, and unlike the old `slippage` path this is not a
    // reconstruction of a percentage the API applied to its own quote.
    amountOutMinimum: params.minAcceptableAmountOut,
    minOutSource: 'venue'
  }
}

/**
 * Indicative 1inch price via the Classic Swap `/quote` endpoint: same routing as `/swap` but returns
 * only `dstAmount` (no `tx`, no taker), so it is the cheap probe used to rank venues by output.
 */
export async function priceOneInch(
  client: RateLimitedClient,
  entry: OneInchEntry,
  params: PriceParameters
): Promise<PriceQuote> {
  const json = await client.getJson<{ dstAmount?: string }>({
    venue: '1inch',
    url: `${entry.baseUrl ?? ONEINCH_BASE_URL}/swap/v6.1/${params.chainId}/quote`,
    searchParams: {
      src: params.tokenIn,
      dst: params.tokenOut,
      amount: params.amountIn.toString()
    }
  })

  if (!json.dstAmount) throw new QuoteError('no_route', '1inch: no route for this pair/size')
  return { expectedAmountOut: BigInt(json.dstAmount) }
}
