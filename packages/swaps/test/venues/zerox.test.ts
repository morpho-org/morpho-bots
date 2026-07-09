import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { RateLimitedClient } from '../../src/http-client'
import type { QuoteParameters } from '../../src/types'

import { ZEROX_ALLOWANCE_HOLDER } from '../../src/constants'
import { QuoteError } from '../../src/types'
import { quoteZerox } from '../../src/venues/zerox'

const TARGET = getAddress('0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa')
const SPENDER = getAddress('0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')

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

describe('quoteZerox', () => {
  it('maps a quote into a fixed-amount Swap and requests with taker = executor', async () => {
    const { client, calls } = fakeClient({
      liquidityAvailable: true,
      buyAmount: '2000',
      minBuyAmount: '1990',
      transaction: { to: TARGET, data: '0xabc', value: '0' },
      issues: { allowance: { spender: SPENDER } }
    })
    const swap = await quoteZerox(client, {}, params)

    expect(swap.spender).toBe(SPENDER)
    expect(swap.target).toBe(TARGET)
    expect(swap.value).toBe(0n)
    expect(swap.callData).toBe('0xabc')
    expect(swap.amountIn).toEqual({ source: 'fixed', value: 100n })
    expect(swap.expectedAmountOut).toBe(2000n)
    expect(swap.amountOutMinimum).toBe(1990n)

    expect(calls[0]?.searchParams).toMatchObject({
      sellToken: COLLATERAL,
      buyToken: LOAN,
      sellAmount: '100',
      taker: EXECUTOR,
      slippageBps: '50'
    })
  })

  it('falls back to the canonical AllowanceHolder when the response omits the allowance issue', async () => {
    const { client } = fakeClient({
      liquidityAvailable: true,
      buyAmount: '2000',
      minBuyAmount: '1990',
      transaction: { to: TARGET, data: '0xabc' },
      issues: { allowance: null }
    })
    const swap = await quoteZerox(client, {}, params)
    expect(swap.spender).toBe(ZEROX_ALLOWANCE_HOLDER)
  })

  it('throws no_route when liquidity is unavailable', async () => {
    const { client } = fakeClient({ liquidityAvailable: false })
    const reason = await quoteZerox(client, {}, params).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('no_route')
  })
})
