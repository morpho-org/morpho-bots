import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { RateLimitedClient } from '../../src/http-client'
import type { PriceParameters, QuoteParameters } from '../../src/types'

import { QuoteError } from '../../src/types'
import { priceLiquidSwap, quoteLiquidSwap } from '../../src/venues/liquidswap'

const TARGET = getAddress('0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')

// 1.5 collateral tokens at 18 decimals — proves base-units → human-readable "1.5" conversion.
const params: QuoteParameters = {
  chainId: 999,
  tokenIn: COLLATERAL,
  tokenOut: LOAN,
  amountIn: 1_500_000_000_000_000_000n,
  slippageBps: 150,
  executor: EXECUTOR,
  referenceAmountOut: 3_000_000_000n,
  tokenInDecimals: 18
}

// A fake client that returns a fixed JSON body and records the request args.
function fakeClient(body: unknown) {
  const calls: { venue: string; url: string; searchParams?: Record<string, string> }[] = []
  const client: RateLimitedClient = {
    getJson: async <T>(args: {
      venue: string
      url: string
      searchParams?: Record<string, string>
    }) => {
      calls.push(args)
      return body as T
    }
  }
  return { client, calls }
}

function okBody() {
  return {
    success: true,
    amountOut: '3000.5', // decimal string → parseUnits(_, 6) = 3000500000
    tokens: { tokenOut: { decimals: 6 } },
    execution: { to: TARGET, calldata: '0xabc', details: { minAmountOut: '2955000000' } }
  }
}

describe('quoteLiquidSwap', () => {
  it('maps a route into a fixed-amount Swap; amountIn is decimal, slippage is percent', async () => {
    const { client, calls } = fakeClient(okBody())
    const swap = await quoteLiquidSwap(client, {}, params)

    expect(swap.spender).toBe(TARGET)
    expect(swap.target).toBe(TARGET) // approve + swap target the same address
    expect(swap.value).toBe(0n)
    expect(swap.callData).toBe('0xabc')
    expect(swap.amountIn).toEqual({ source: 'fixed', value: 1_500_000_000_000_000_000n })
    expect(swap.expectedAmountOut).toBe(3_000_500_000n)
    expect(swap.amountOutMinimum).toBe(2_955_000_000n)

    expect(calls[0]?.url).toContain('/route')
    expect(calls[0]?.searchParams).toMatchObject({
      multiHop: 'true',
      tokenIn: COLLATERAL,
      tokenOut: LOAN,
      amountIn: '1.5', // formatUnits(1.5e18, 18) — NOT base units
      slippage: '1.5' // slippageBps / 100
    })
  })

  it('throws api_error and makes NO api call when tokenInDecimals is missing', async () => {
    const { client, calls } = fakeClient(okBody())
    const { tokenInDecimals: _omit, ...noDecimals } = params
    const reason = await quoteLiquidSwap(client, {}, noDecimals as QuoteParameters).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('api_error')
    expect(calls.length).toBe(0) // fails before the HTTP call
  })

  it('throws no_route when the route is unsuccessful', async () => {
    const { client } = fakeClient({ success: false })
    const reason = await quoteLiquidSwap(client, {}, params).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('no_route')
  })

  it('throws no_route when execution/minAmountOut is missing', async () => {
    const { client } = fakeClient({
      success: true,
      amountOut: '3000.5',
      tokens: { tokenOut: { decimals: 6 } },
      execution: { to: TARGET, calldata: '0xabc' } // no details.minAmountOut
    })
    const reason = await quoteLiquidSwap(client, {}, params).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('no_route')
  })

  it('throws api_error when execution.calldata is not hex', async () => {
    const { client } = fakeClient({
      ...okBody(),
      execution: { ...okBody().execution, calldata: 'nope' }
    })
    const reason = await quoteLiquidSwap(client, {}, params).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('api_error')
  })

  it('throws api_error when amountOut is not a number', async () => {
    const { client } = fakeClient({ ...okBody(), amountOut: 'not-a-number' })
    const reason = await quoteLiquidSwap(client, {}, params).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('api_error')
  })
})

describe('priceLiquidSwap', () => {
  const priceParams: PriceParameters = {
    chainId: 999,
    tokenIn: COLLATERAL,
    tokenOut: LOAN,
    amountIn: 1_500_000_000_000_000_000n,
    tokenInDecimals: 18
  }

  it('probes /route (no slippage) and returns the parsed amountOut', async () => {
    const { client, calls } = fakeClient({
      success: true,
      amountOut: '3000.5',
      tokens: { tokenOut: { decimals: 6 } }
    })
    const quote = await priceLiquidSwap(client, {}, priceParams)

    expect(quote.expectedAmountOut).toBe(3_000_500_000n)
    expect(calls[0]?.searchParams).toMatchObject({ amountIn: '1.5' })
    expect(calls[0]?.searchParams?.slippage).toBeUndefined()
  })

  it('throws no_route when the route is unsuccessful', async () => {
    const { client } = fakeClient({ success: false })
    const reason = await priceLiquidSwap(client, {}, priceParams).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('no_route')
  })
})
