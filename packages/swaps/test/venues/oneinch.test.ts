import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { RateLimitedClient } from '../../src/http-client'
import type { QuoteParameters } from '../../src/types'

import { ONEINCH_ROUTER } from '../../src/constants'
import { QuoteError } from '../../src/types'
import { priceOneInch, quoteOneInch } from '../../src/venues/oneinch'

// The 1inch swap must target the statically-known router for the chain (Base here); the adapter
// pins `tx.to` to it, so the happy-path fixture returns exactly this address.
const ROUTER = ONEINCH_ROUTER[8453]!
const TARGET = getAddress('0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const EOA = getAddress('0x2222222222222222222222222222222222222222')

const params: QuoteParameters = {
  chainId: 8453,
  tokenIn: COLLATERAL,
  tokenOut: LOAN,
  amountIn: 100n,
  slippageBps: 50, // 0.5%
  executor: EXECUTOR,
  initiatingEoa: EOA,
  referenceAmountOut: 2000n,
  minAcceptableAmountOut: 1990n
}

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

describe('quoteOneInch', () => {
  it('maps a swap into a fixed-amount Swap with the static Base router as spender', async () => {
    const { client, calls } = fakeClient({
      dstAmount: '2000',
      tx: { to: ROUTER, data: '0xdef', value: '0' }
    })
    const swap = await quoteOneInch(client, {}, params)

    expect(swap.spender).toBe(ONEINCH_ROUTER[8453]!)
    // tx.to is pinned to (and equals) the static router — target and approval stay in lockstep.
    expect(swap.target).toBe(ROUTER)
    expect(swap.callData).toBe('0xdef')
    expect(swap.amountIn).toEqual({ source: 'fixed', value: 100n })
    expect(swap.expectedAmountOut).toBe(2000n)
    // 2000 × (10000 - 50) / 10000 = 1990.
    expect(swap.amountOutMinimum).toBe(1990n)
    // Reported, not reconstructed: the absolute floor we asked the router to enforce.
    expect(swap.minOutSource).toBe('venue')

    // Exact, so a stray or missing search param fails here. `from` is the caller (the Executor) and
    // `origin` the initiating EOA — 1inch's schema declares both, and they are NOT the same address.
    expect(calls[0]?.url).toContain('/swap/v6.1/8453/swap')
    expect(calls[0]?.searchParams).toStrictEqual({
      src: COLLATERAL,
      dst: LOAN,
      amount: '100',
      from: EXECUTOR,
      origin: EOA,
      receiver: EXECUTOR,
      minReturn: '1990',
      disableEstimate: 'true'
    })
  })

  it('fails loud rather than quoting without an initiating EOA', async () => {
    // `origin` is required by 1inch's schema, so a caller that did not thread the EOA must fail
    // before the request — never silently omit it and let the rejection look like a no-route.
    const { client, calls } = fakeClient({ dstAmount: '2000', tx: { to: ROUTER, data: '0xdef' } })
    const error = await quoteOneInch(client, {}, { ...params, initiatingEoa: undefined }).catch(
      e => e
    )
    expect(error).toBeInstanceOf(QuoteError)
    expect((error as QuoteError).reason).toBe('api_error')
    expect(calls).toHaveLength(0)
  })

  it('rejects a response whose tx.to is not the configured router', async () => {
    // A compromised/misdirected API answer points the swap (and its approval) at an arbitrary
    // contract. The adapter must fail the quote loudly (api_error) with BOTH addresses in the
    // message — the quoting layer surfaces that as `quote.failed`'s `detail`.
    const { client } = fakeClient({
      dstAmount: '2000',
      tx: { to: TARGET, data: '0xdef', value: '0' }
    })
    const error = await quoteOneInch(client, {}, params).catch(e => e)
    expect(error).toBeInstanceOf(QuoteError)
    expect((error as QuoteError).reason).toBe('api_error')
    // Both the offending target and the expected router appear in the detail.
    expect((error as QuoteError).message).toContain(TARGET)
    expect((error as QuoteError).message).toContain(ROUTER)
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
    // 31337 (anvil/local) has no 1inch deployment, so it is absent from ONEINCH_ROUTER.
    const reason = await quoteOneInch(client, {}, { ...params, chainId: 31337 }).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('api_error')
  })
})

describe('priceOneInch', () => {
  const priceParams = { chainId: 8453, tokenIn: COLLATERAL, tokenOut: LOAN, amountIn: 100n }

  it('hits the indicative /quote endpoint (no from) and returns dstAmount', async () => {
    const { client, calls } = fakeClient({ dstAmount: '2000' })
    const quote = await priceOneInch(client, {}, priceParams)

    expect(quote.expectedAmountOut).toBe(2000n)
    // The indicative probe has no taker, so neither `from` nor `origin` belongs on it.
    expect(calls[0]?.url).toContain('/swap/v6.1/8453/quote')
    expect(calls[0]?.searchParams).toStrictEqual({ src: COLLATERAL, dst: LOAN, amount: '100' })
  })

  it('throws no_route when there is no dstAmount', async () => {
    const { client } = fakeClient({})
    const reason = await priceOneInch(client, {}, priceParams).catch(e =>
      e instanceof QuoteError ? e.reason : 'other'
    )
    expect(reason).toBe('no_route')
  })
})
