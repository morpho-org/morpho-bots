import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { RateLimitedClient } from '../../src/http-client'
import type { PriceParameters, QuoteParameters } from '../../src/types'

import { QuoteError } from '../../src/types'
import { priceLifi, quoteLifi } from '../../src/venues/lifi'

const APPROVAL = getAddress('0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB')
const TARGET = getAddress('0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const PROBE_ADDRESS = getAddress('0x000000000000000000000000000000000000dEaD')

const params: QuoteParameters = {
  chainId: 8453,
  tokenIn: COLLATERAL,
  tokenOut: LOAN,
  amountIn: 100n,
  slippageBps: 50,
  executor: EXECUTOR,
  referenceAmountOut: 2000n
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

describe('quoteLifi', () => {
  it('maps a quote into a fixed-amount Swap with slippage as a decimal fraction', async () => {
    const { client, calls } = fakeClient({
      estimate: { approvalAddress: APPROVAL, toAmount: '2000', toAmountMin: '1990' },
      // JSON-RPC tx shape: `value` is a hex string (0x10 = 16), not decimal.
      transactionRequest: { to: TARGET, data: '0xabc', value: '0x10' }
    })
    const swap = await quoteLifi(client, {}, params)

    expect(swap.spender).toBe(APPROVAL)
    expect(swap.target).toBe(TARGET)
    expect(swap.value).toBe(16n)
    expect(swap.callData).toBe('0xabc')
    expect(swap.amountIn).toEqual({ source: 'fixed', value: 100n })
    expect(swap.expectedAmountOut).toBe(2000n)
    expect(swap.amountOutMinimum).toBe(1990n)

    expect(calls[0]?.url).toContain('/quote')
    expect(calls[0]?.searchParams).toMatchObject({
      fromChain: '8453',
      toChain: '8453',
      fromToken: COLLATERAL,
      toToken: LOAN,
      fromAmount: '100',
      fromAddress: EXECUTOR,
      slippage: '0.005',
      // The Executor is zeroed at quote time, so the default balance/approval simulation must be
      // skipped or every firm quote fails — mirrors 1inch's disableEstimate.
      skipSimulation: 'true',
      integrator: 'morpho-curator-bots'
    })
  })

  it('defaults value to 0 when transactionRequest.value is absent', async () => {
    const { client } = fakeClient({
      estimate: { approvalAddress: APPROVAL, toAmount: '2000', toAmountMin: '1990' },
      transactionRequest: { to: TARGET, data: '0xabc' }
    })
    const swap = await quoteLifi(client, {}, params)
    expect(swap.value).toBe(0n)
  })

  it('throws no_route when the estimate/transactionRequest is missing', async () => {
    const { client } = fakeClient({ estimate: { toAmount: '2000' } })
    const reason = await quoteLifi(client, {}, params).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('no_route')
  })

  it('throws api_error when transactionRequest.data is not hex', async () => {
    const { client } = fakeClient({
      estimate: { approvalAddress: APPROVAL, toAmount: '2000', toAmountMin: '1990' },
      transactionRequest: { to: TARGET, data: 'not-hex' }
    })
    const reason = await quoteLifi(client, {}, params).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('api_error')
  })
})

describe('priceLifi', () => {
  const priceParams: PriceParameters = {
    chainId: 8453,
    tokenIn: COLLATERAL,
    tokenOut: LOAN,
    amountIn: 100n
  }

  it('probes /quote with a placeholder sender, zero slippage, and skipSimulation', async () => {
    const { client, calls } = fakeClient({ estimate: { toAmount: '2000' } })
    const quote = await priceLifi(client, {}, priceParams)

    expect(quote.expectedAmountOut).toBe(2000n)
    expect(calls[0]?.url).toContain('/quote')
    expect(calls[0]?.searchParams).toMatchObject({
      fromChain: '8453',
      toChain: '8453',
      fromToken: COLLATERAL,
      toToken: LOAN,
      fromAmount: '100',
      fromAddress: PROBE_ADDRESS,
      slippage: '0',
      skipSimulation: 'true'
    })
    // The probe never uses the real executor — PriceParameters carries none.
    expect(calls[0]?.searchParams?.fromAddress).not.toBe(EXECUTOR)
  })

  it('throws no_route when no estimate.toAmount is returned', async () => {
    const { client } = fakeClient({ estimate: {} })
    const reason = await priceLifi(client, {}, priceParams).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('no_route')
  })
})
