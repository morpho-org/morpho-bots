import { safeParseUnits } from '@repo/utils'
import { formatUnits, getAddress, isHex } from 'viem'

import type { RateLimitedClient } from '../http-client'
import type { PriceParameters, PriceQuote, QuoteParameters, Swap } from '../types'

import { LIQUIDSWAP_BASE_URL } from '../constants'
import { QuoteError } from '../types'

/** The LiquidSwap arm of the per-collateral swap config. */
type LiquidSwapEntry = { baseUrl?: string }

// Subset of the liqd.ag `/route` response we consume. `amountOut` is a human-readable DECIMAL string
// (e.g. "6773.208147"); `execution.details.minAmountOut` is the slippage-adjusted floor in BASE units.
type LiquidSwapRoute = {
  success?: boolean
  amountOut?: string
  tokens?: { tokenOut?: { decimals?: number } | null } | null
  execution?: { to?: string; calldata?: string; details?: { minAmountOut?: string } | null } | null
}

// liqd.ag is decimal-denominated: `amountIn` is a human-readable token amount, not base units. Our
// params carry base units + tokenIn decimals, so convert with viem's `formatUnits` (full precision —
// the API accepts arbitrary decimal strings, so there is no rounding loss).
function amountInDecimalString(params: QuoteParameters | PriceParameters): string {
  if (params.tokenInDecimals === undefined) {
    throw new QuoteError(
      'api_error',
      'liquidswap: tokenInDecimals is required to denominate amountIn'
    )
  }
  return formatUnits(params.amountIn, params.tokenInDecimals)
}

/**
 * Quotes LiquidSwap (liqd.ag) via the one-step `/route` endpoint, which returns ready-to-use
 * `execution` calldata and a plain-ERC20-`approve` spender (`execution.to` — the swap and the approval
 * target the same address; no Permit2, no key). `slippage` is a percent (bps / 100) and the API bakes
 * the resulting `execution.details.minAmountOut` (base units) into the calldata. The sell amount is
 * committed off-chain, so the {@link Swap} carries `amountIn: { source: 'fixed' }`.
 */
export async function quoteLiquidSwap(
  client: RateLimitedClient,
  entry: LiquidSwapEntry,
  params: QuoteParameters
): Promise<Swap> {
  // Fail loud BEFORE the HTTP call if the caller didn't supply decimals — a misconfigured firm quote
  // must not burn an API request.
  const amountIn = amountInDecimalString(params)

  const json = await client.getJson<LiquidSwapRoute>({
    venue: 'liquidswap',
    url: `${entry.baseUrl ?? LIQUIDSWAP_BASE_URL}/route`,
    searchParams: {
      multiHop: 'true',
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn,
      slippage: String(params.slippageBps / 100)
    }
  })

  const minAmountOut = json.execution?.details?.minAmountOut
  const outDecimals = json.tokens?.tokenOut?.decimals
  // Presence-first so the fields are narrowed to non-undefined before parsing (strict typecheck).
  if (
    !json.success ||
    !json.execution?.to ||
    !json.execution.calldata ||
    !minAmountOut ||
    json.amountOut === undefined ||
    outDecimals === undefined
  ) {
    throw new QuoteError('no_route', 'liquidswap: no route for this pair/size')
  }
  if (!isHex(json.execution.calldata)) {
    throw new QuoteError('api_error', 'liquidswap: execution.calldata is not hex')
  }
  const expectedAmountOut = safeParseUnits(json.amountOut, outDecimals)
  if (expectedAmountOut === null) {
    throw new QuoteError('api_error', 'liquidswap: amountOut is not a number')
  }

  const target = getAddress(json.execution.to)
  return {
    spender: target,
    target,
    // Collateral is always an ERC20 — never forward native value.
    value: 0n,
    callData: json.execution.calldata,
    amountIn: { source: 'fixed', value: params.amountIn },
    expectedAmountOut,
    amountOutMinimum: BigInt(minAmountOut)
  }
}

/**
 * Indicative LiquidSwap price via the same `/route` endpoint (no dedicated price route) — omit
 * `slippage` and read only `amountOut`, so it is the cheap probe used to rank venues by output.
 */
export async function priceLiquidSwap(
  client: RateLimitedClient,
  entry: LiquidSwapEntry,
  params: PriceParameters
): Promise<PriceQuote> {
  const amountIn = amountInDecimalString(params)

  const json = await client.getJson<LiquidSwapRoute>({
    venue: 'liquidswap',
    url: `${entry.baseUrl ?? LIQUIDSWAP_BASE_URL}/route`,
    searchParams: {
      multiHop: 'true',
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn
    }
  })

  const outDecimals = json.tokens?.tokenOut?.decimals
  if (!json.success || json.amountOut === undefined || outDecimals === undefined) {
    throw new QuoteError('no_route', 'liquidswap: no route for this pair/size')
  }
  const expectedAmountOut = safeParseUnits(json.amountOut, outDecimals)
  if (expectedAmountOut === null) {
    throw new QuoteError('api_error', 'liquidswap: amountOut is not a number')
  }
  return { expectedAmountOut }
}
