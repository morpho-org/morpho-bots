import { getAddress, isHex } from 'viem'

import type { RateLimitedClient } from '../http-client'
import type { QuoteParameters, Swap } from '../types'

import { ZEROX_ALLOWANCE_HOLDER, ZEROX_BASE_URL } from '../constants'
import { QuoteError } from '../types'

/** The 0x arm of the per-collateral swap config. */
type ZeroxEntry = { baseUrl?: string }

// Subset of the 0x Swap API v2 (AllowanceHolder) `/quote` response we consume.
type ZeroxQuote = {
  liquidityAvailable?: boolean
  buyAmount?: string
  minBuyAmount?: string
  transaction?: { to?: string; data?: string; value?: string }
  issues?: { allowance?: { spender?: string } | null } | null
}

/**
 * Quotes 0x via the one-step AllowanceHolder `/quote` endpoint, which returns ready-to-use calldata
 * and a plain-ERC20-`approve` spender (no Permit2 signature). The bought token lands on `taker` (the
 * Executor) by default. `sellAmount` is committed off-chain (route-bound calldata), so the resulting
 * {@link Swap} carries `amountIn: { source: 'fixed' }`.
 */
export async function quoteZerox(
  client: RateLimitedClient,
  entry: ZeroxEntry,
  params: QuoteParameters
): Promise<Swap> {
  const json = await client.getJson<ZeroxQuote>({
    venue: '0x',
    url: `${entry.baseUrl ?? ZEROX_BASE_URL}/swap/allowance-holder/quote`,
    searchParams: {
      chainId: String(params.chainId),
      sellToken: params.tokenIn,
      buyToken: params.tokenOut,
      sellAmount: params.amountIn.toString(),
      taker: params.executor,
      slippageBps: String(params.slippageBps)
    }
  })

  if (json.liquidityAvailable === false || !json.transaction?.to || !json.transaction.data) {
    throw new QuoteError('no_route', '0x: no liquidity available for this pair/size')
  }
  if (!isHex(json.transaction.data)) {
    throw new QuoteError('api_error', '0x: transaction.data is not hex')
  }

  // The docs say approve AllowanceHolder, not the Settler. Prefer the response's spender; fall back to
  // the canonical AllowanceHolder (the response omits `issues.allowance` when it thinks allowance is
  // already sufficient, which never holds for the always-zeroed Executor).
  const spender = getAddress(json.issues?.allowance?.spender ?? ZEROX_ALLOWANCE_HOLDER)

  return {
    spender,
    target: getAddress(json.transaction.to),
    value: BigInt(json.transaction.value ?? '0'),
    callData: json.transaction.data,
    amountIn: { source: 'fixed', value: params.amountIn },
    expectedAmountOut: BigInt(json.buyAmount ?? '0'),
    amountOutMinimum: BigInt(json.minBuyAmount ?? '0')
  }
}
