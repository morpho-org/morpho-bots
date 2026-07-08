import { getAddress, isHex } from 'viem'

import type { RateLimitedClient } from '../http-client'
import type { QuoteParameters, Swap } from '../types'

import { BPS, ONEINCH_BASE_URL, ONEINCH_ROUTER } from '../../constants'
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
      slippage: (params.slippageBps / 100).toString(),
      disableEstimate: 'true'
    }
  })

  if (!json.tx?.to || !json.tx.data) {
    throw new QuoteError('no_route', '1inch: no route for this pair/size')
  }
  if (!isHex(json.tx.data)) {
    throw new QuoteError('api_error', '1inch: tx.data is not hex')
  }

  const expectedAmountOut = BigInt(json.dstAmount ?? '0')
  return {
    spender: router,
    target: getAddress(json.tx.to),
    value: BigInt(json.tx.value ?? '0'),
    callData: json.tx.data,
    amountIn: { source: 'fixed', value: params.amountIn },
    expectedAmountOut,
    amountOutMinimum: (expectedAmountOut * (BPS - BigInt(params.slippageBps))) / BPS
  }
}
