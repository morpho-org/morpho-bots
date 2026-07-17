import type { Address } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress, isAddressEqual } from 'viem'

import type { HttpVenue, RateLimitedClient } from '../src/http-client'
import type { QuoteLogger, QuoteRequest } from '../src/quoting'
import type { QuoteOutcome, Venue } from '../src/types'
import type { Unwrapper } from '../src/unwrappers/resolve'

import { ONEINCH_ROUTER, ZEROX_ALLOWANCE_HOLDER } from '../src/constants'
import { composeMultiVenueQuoting, passesRouteQuality } from '../src/quoting'
import { QuoteError } from '../src/types'

const NOOP_LOGGER: QuoteLogger = { info: () => {}, warn: () => {} }

const ROUTER = getAddress('0x5555555555555555555555555555555555555555')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const UNDERLYING = getAddress('0x8888888888888888888888888888888888888888')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')

// referenceAmountOut = amountIn = 1000 (i.e. an oracle price of exactly 1) — the route-quality
// reference the maxRouteImpactBps floor is applied to.
const REQUEST: QuoteRequest = {
  collateralToken: COLLATERAL,
  loanToken: LOAN,
  amountIn: 1000n,
  referenceAmountOut: 1000n
}

// The plan's final step is the venue swap; its approvalSpender is the venue's approve target — the
// same identity the pre-SwapPlan tests asserted via `swap.spender`.
function finalSpender(outcome: QuoteOutcome): Address | undefined {
  return outcome.kind === 'swap' ? outcome.plan.steps.at(-1)?.approvalSpender : undefined
}

// An unwrapper that converts `from` → `to` at the given output, recording the tokens it was asked
// about; every other token resolves null (not unwrappable).
function fakeUnwrapper(args: { from: Address; to: Address; out: bigint }): Unwrapper & {
  probed: Address[]
} {
  const probed: Address[] = []
  return {
    kind: 'fake',
    probed,
    async resolve({ token }) {
      probed.push(token)
      if (!isAddressEqual(token, args.from)) return null
      return {
        step: {
          tokenIn: args.from,
          tokenOut: args.to,
          target: args.from,
          value: 0n,
          callData: '0x12345678',
          amountIn: { source: 'balance', offset: 4n }
        },
        expectedAmountOut: args.out,
        amountOutMinimum: args.out
      }
    }
  }
}

const throwingHttp: RateLimitedClient = {
  getJson: async () => {
    throw new QuoteError('rate_limited', 'boom')
  }
}

describe('passesRouteQuality', () => {
  // floor = 1000 × (10000 - 500) / 10000 = 950.
  it('accepts an output at or above the floor', () => {
    expect(passesRouteQuality({ expected: 950n, reference: 1000n, maxBps: 500 })).toBe(true)
    expect(passesRouteQuality({ expected: 1200n, reference: 1000n, maxBps: 500 })).toBe(true)
  })

  it('rejects an output below the floor', () => {
    expect(passesRouteQuality({ expected: 949n, reference: 1000n, maxBps: 500 })).toBe(false)
  })
})

// A 0x-shaped firm-quote body (AllowanceHolder) with the given buyAmount.
function zeroxBody(buyAmount: string) {
  return {
    liquidityAvailable: true,
    buyAmount,
    minBuyAmount: buyAmount,
    transaction: { to: ROUTER, data: '0xabc', value: '0' }
  }
}

// A 1inch-shaped firm-swap body with the given dstAmount. `tx.to` must be the static per-chain
// AggregationRouterV6 — the adapter pins it — so use the real Base router, not the generic ROUTER.
function oneInchBody(dstAmount: string) {
  return { dstAmount, tx: { to: ONEINCH_ROUTER[8453]!, data: '0xdef', value: '0' } }
}

const LIFI_SPENDER = getAddress('0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB')

// A LiFi-shaped firm-quote body with the given toAmount.
function lifiBody(toAmount: string) {
  return {
    estimate: { approvalAddress: LIFI_SPENDER, toAmount, toAmountMin: toAmount },
    transactionRequest: { to: ROUTER, data: '0xfee', value: '0x0' }
  }
}

const LIQUIDSWAP_TARGET = getAddress('0x2222222222222222222222222222222222222222')

// A LiquidSwap-shaped firm-route body; `amountOut` is a decimal string parsed at `decimals: 0`.
function liquidSwapBody(amountOut: string) {
  return {
    success: true,
    amountOut,
    tokens: { tokenOut: { decimals: 0 } },
    execution: { to: LIQUIDSWAP_TARGET, calldata: '0x0abc', details: { minAmountOut: amountOut } }
  }
}

// A client that dispatches a fixed body per venue (throws no_route for an unstubbed venue).
function multiHttp(bodies: Partial<Record<HttpVenue, unknown>>): RateLimitedClient {
  return {
    getJson: async <T>(args: { venue: HttpVenue }) => {
      const body = bodies[args.venue]
      if (body === undefined) throw new QuoteError('no_route', `no stub for ${args.venue}`)
      return body as T
    }
  }
}

function composeMulti(
  venues: Venue[],
  order: { venue: Venue; expectedOut: bigint }[],
  httpClient: RateLimitedClient,
  options: { unwrappers?: readonly Unwrapper[] } = {}
) {
  const refreshed: { collateral: Address; loan: Address }[] = []
  const selected: { pair: { collateral: Address; loan: Address }; amountIn: bigint }[] = []
  const quoting = composeMultiVenueQuoting({
    httpClient,
    chainId: 8453,
    executor: EXECUTOR,
    venues,
    slippageBps: 50,
    baseUrls: {},
    maxRouteImpactBps: 500, // floor = 950
    unwrappers: options.unwrappers ?? [],
    refresh: async pair => {
      refreshed.push(pair)
    },
    select: (pair, amountIn) => {
      selected.push({ pair, amountIn })
      return order
    },
    logger: NOOP_LOGGER
  })
  return { ...quoting, refreshed, selected }
}

describe('composeMultiVenueQuoting', () => {
  it('returns no_config (no API call) when no venues are enabled', async () => {
    const { quoteFor } = composeMulti([], [], multiHttp({}))
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'no_config' })
  })

  it('quotes the top-ranked venue when it passes route quality', async () => {
    const { quoteFor } = composeMulti(
      ['0x', '1inch'],
      [
        { venue: '0x', expectedOut: 1000n },
        { venue: '1inch', expectedOut: 980n }
      ],
      multiHttp({ '0x': zeroxBody('1000'), '1inch': oneInchBody('980') })
    )
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    // 0x's AllowanceHolder spender proves the 0x arm won (not 1inch's router).
    expect(finalSpender(outcome)).toBe(ZEROX_ALLOWANCE_HOLDER)
  })

  it('falls through to the runner-up venue when the top one fails route quality', async () => {
    const { quoteFor } = composeMulti(
      ['0x', '1inch'],
      [
        { venue: '0x', expectedOut: 900n },
        { venue: '1inch', expectedOut: 990n }
      ],
      // 0x quotes 900 (< floor 950) → fall through; 1inch quotes 990 (≥ 950) → win.
      multiHttp({ '0x': zeroxBody('900'), '1inch': oneInchBody('990') })
    )
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    expect(finalSpender(outcome)).toBe(ONEINCH_ROUTER[8453])
  })

  it('uses the deterministic enabled-venue order when the pair is not yet probed (cold cache)', async () => {
    const { quoteFor } = composeMulti(['0x', '1inch'], [], multiHttp({ '0x': zeroxBody('1000') }))
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    expect(finalSpender(outcome)).toBe(ZEROX_ALLOWANCE_HOLDER)
  })

  it('still firm-quotes an enabled venue the probe cache could not rank, after ranked venues fail', async () => {
    // 0x is enabled but absent from the ranking (its probe transiently failed); the ranked venue
    // (1inch) firm-quotes below the floor → the fall-through must reach 0x anyway, not stop at the
    // ranking's edge for a full staleMs window.
    const { quoteFor } = composeMulti(
      ['0x', '1inch'],
      [{ venue: '1inch', expectedOut: 990n }],
      multiHttp({ '1inch': oneInchBody('900'), '0x': zeroxBody('1000') })
    )
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    expect(finalSpender(outcome)).toBe(ZEROX_ALLOWANCE_HOLDER)
  })

  it('maps an adapter QuoteError to a failed outcome with its reason', async () => {
    const { quoteFor } = composeMulti(['0x'], [{ venue: '0x', expectedOut: 1000n }], throwingHttp)
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'failed', reason: 'rate_limited' })
  })

  it('maps an unwrapper error to a failed outcome', async () => {
    const broken: Unwrapper = {
      kind: 'broken',
      resolve: async () => {
        throw new QuoteError('api_error', 'probe exploded')
      }
    }
    const { quoteFor } = composeMulti(['0x'], [], multiHttp({}), { unwrappers: [broken] })
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'failed', reason: 'api_error' })
  })

  it('route-quality-checks an unwrap-only plan (chain ends in the loan token)', async () => {
    // Output 900 < floor 950 → the oracle sanity check applies to unwrap-only plans too.
    const bad = fakeUnwrapper({ from: COLLATERAL, to: LOAN, out: 900n })
    const { quoteFor } = composeMulti(['0x'], [], multiHttp({}), { unwrappers: [bad] })
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'failed', reason: 'bad_route' })
  })

  it('drops the request tokenInDecimals after an unwrap (they described the raw collateral)', async () => {
    const unwrapper = fakeUnwrapper({ from: COLLATERAL, to: UNDERLYING, out: 1000n })
    // LiquidSwap requires tokenInDecimals; the post-unwrap quote must NOT reuse the share token's,
    // so its adapter throws api_error and the (single-venue) run fails.
    const { quoteFor } = composeMulti(
      ['liquidswap'],
      [{ venue: 'liquidswap', expectedOut: 1000n }],
      multiHttp({ liquidswap: liquidSwapBody('1000') }),
      { unwrappers: [unwrapper] }
    )
    expect(await quoteFor({ ...REQUEST, tokenInDecimals: 18 })).toEqual({
      kind: 'failed',
      reason: 'api_error'
    })
  })

  it('quotes the lifi arm (approvalAddress spender) when it is ranked top', async () => {
    const { quoteFor } = composeMulti(
      ['lifi', '0x'],
      [
        { venue: 'lifi', expectedOut: 1000n },
        { venue: '0x', expectedOut: 980n }
      ],
      multiHttp({ lifi: lifiBody('1000'), '0x': zeroxBody('980') })
    )
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    // LiFi's approvalAddress proves the lifi arm won (entryFor + quoteByVenue dispatch).
    expect(finalSpender(outcome)).toBe(LIFI_SPENDER)
  })

  it('quotes the liquidswap arm (execution.to spender) when ranked top, with tokenInDecimals', async () => {
    const { quoteFor } = composeMulti(
      ['liquidswap', '0x'],
      [
        { venue: 'liquidswap', expectedOut: 1000n },
        { venue: '0x', expectedOut: 980n }
      ],
      multiHttp({ liquidswap: liquidSwapBody('1000'), '0x': zeroxBody('980') })
    )
    // tokenInDecimals is required for liquidswap to denominate amountIn.
    const outcome = await quoteFor({ ...REQUEST, tokenInDecimals: 6 })
    expect(outcome.kind).toBe('swap')
    expect(finalSpender(outcome)).toBe(LIQUIDSWAP_TARGET)
  })

  it('falls through liquidswap (fails, no escape) when the request omits tokenInDecimals', async () => {
    const { quoteFor } = composeMulti(
      ['liquidswap', '0x'],
      [
        { venue: 'liquidswap', expectedOut: 1000n },
        { venue: '0x', expectedOut: 1000n }
      ],
      multiHttp({ liquidswap: liquidSwapBody('1000'), '0x': zeroxBody('1000') })
    )
    // No tokenInDecimals → liquidswap throws api_error → coverage-first fall-through to 0x.
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    expect(finalSpender(outcome)).toBe(ZEROX_ALLOWANCE_HOLDER)
  })

  it('fails with the last reason when every ranked venue fails', async () => {
    const { quoteFor } = composeMulti(
      ['0x'],
      [{ venue: '0x', expectedOut: 1000n }],
      multiHttp({ '0x': { liquidityAvailable: false } })
    )
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'failed', reason: 'no_route' })
  })

  it('probes and selects the POST-unwrap pair with the threaded worst-case amount', async () => {
    const unwrapper = fakeUnwrapper({ from: COLLATERAL, to: UNDERLYING, out: 970n })
    const { quoteFor, refreshed, selected } = composeMulti(
      ['0x'],
      [{ venue: '0x', expectedOut: 1000n }],
      multiHttp({ '0x': zeroxBody('990') }),
      { unwrappers: [unwrapper] }
    )
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    // The probe/ranking pair is the tradable underlying, sized by the unwrap's worst-case output.
    expect(refreshed).toEqual([{ collateral: UNDERLYING, loan: LOAN }])
    expect(selected).toEqual([{ pair: { collateral: UNDERLYING, loan: LOAN }, amountIn: 970n }])
    if (outcome.kind === 'swap') {
      expect(outcome.plan.steps).toHaveLength(2)
      expect(outcome.plan.steps[1]).toMatchObject({ tokenIn: UNDERLYING, tokenOut: LOAN })
    }
  })

  it('returns an unwrap-only plan without probing when the chain ends in the loan token', async () => {
    const unwrapper = fakeUnwrapper({ from: COLLATERAL, to: LOAN, out: 990n })
    const { quoteFor, refreshed } = composeMulti(['0x'], [], multiHttp({}), {
      unwrappers: [unwrapper]
    })
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') expect(outcome.plan.steps).toHaveLength(1)
    expect(refreshed).toHaveLength(0)
  })

  it('skips unwrap resolution entirely in bad-debt-only mode (no venues)', async () => {
    const unwrapper = fakeUnwrapper({ from: COLLATERAL, to: UNDERLYING, out: 970n })
    const { quoteFor } = composeMulti([], [], multiHttp({}), { unwrappers: [unwrapper] })
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'no_config' })
    expect(unwrapper.probed).toHaveLength(0)
  })
})
