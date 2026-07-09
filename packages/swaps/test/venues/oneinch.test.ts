import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { RateLimitedClient } from '../../src/http-client'
import type { QuoteParameters } from '../../src/types'

import { ONEINCH_ROUTER } from '../../src/constants'
import { QuoteError } from '../../src/types'
import { quoteOneInch } from '../../src/venues/oneinch'

const TARGET = getAddress('0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')

const params: QuoteParameters = {
  chainId: 8453,
  tokenIn: COLLATERAL,
  tokenOut: LOAN,
  amountIn: 100n,
  slippageBps: 50, // 0.5%
  executor: EXECUTOR,
  referenceAmountOut: 2000n
}

function fakeClient(body: unknown) {
  const calls: { searchParams?: Record<string, string> }[] = []
  const client: RateLimitedClient = {
    getJson: async <T>(args: { searchParams?: Record<string, string> }) => {
      calls.push(args)
      return body as T
    }
  }
  return { client, calls }
}

describe('quoteOneInch', () => {
  it('maps a swap into a fixed-amount Swap with the static Base router as spender', async () => {
    const { client, calls } = fakeClient({
      dstAmount: '2000',
      tx: { to: TARGET, data: '0xdef', value: '0' }
    })
    const swap = await quoteOneInch(client, {}, params)

    expect(swap.spender).toBe(ONEINCH_ROUTER[8453]!)
    expect(swap.target).toBe(TARGET)
    expect(swap.callData).toBe('0xdef')
    expect(swap.amountIn).toEqual({ source: 'fixed', value: 100n })
    expect(swap.expectedAmountOut).toBe(2000n)
    // 2000 × (10000 - 50) / 10000 = 1990.
    expect(swap.amountOutMinimum).toBe(1990n)

    // slippage is sent as a percentage (bps / 100); output goes to the Executor.
    expect(calls[0]?.searchParams).toMatchObject({
      src: COLLATERAL,
      dst: LOAN,
      amount: '100',
      from: EXECUTOR,
      receiver: EXECUTOR,
      slippage: '0.5'
    })
  })

  it('throws no_route when the response carries no tx', async () => {
    const { client } = fakeClient({ dstAmount: '0' })
    const reason = await quoteOneInch(client, {}, params).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('no_route')
  })

  it('throws api_error for a chain with no configured router', async () => {
    const { client } = fakeClient({ dstAmount: '2000', tx: { to: TARGET, data: '0xdef' } })
    const reason = await quoteOneInch(client, {}, { ...params, chainId: 1 }).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('api_error')
  })
})
