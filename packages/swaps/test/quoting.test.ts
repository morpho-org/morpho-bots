import type { Address } from 'viem'

import { getAddress, isAddressEqual } from 'viem'
import { describe, expect, it } from 'vitest'

import type { HttpVenue, RateLimitedClient } from '../src/http-client'
import type { QuoteLogger, QuoteRequest } from '../src/quoting'
import type { QuoteOutcome, Swap, Venue } from '../src/types'
import type { Unwrapper } from '../src/unwrappers/resolve'

import { ONEINCH_ROUTER, ZEROX_ALLOWANCE_HOLDER } from '../src/constants'
import { routeCostBps } from '../src/cost-bps.utils'
import { clearsFloor, composeMultiVenueQuoting, passesRouteQuality } from '../src/quoting'
import { QuoteError } from '../src/types'

const ROUTER = getAddress('0x5555555555555555555555555555555555555555')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const UNDERLYING = getAddress('0x8888888888888888888888888888888888888888')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const EOA = getAddress('0x2222222222222222222222222222222222222222')

// referenceAmountOut = amountIn = 1000 (i.e. an oracle price of exactly 1) — the route-quality
// reference the maxRouteImpactBps floor is applied to.
const REQUEST: QuoteRequest = {
  collateralToken: COLLATERAL,
  loanToken: LOAN,
  amountIn: 1000n,
  referenceAmountOut: 1000n,
  // Break-even below the route-quality floor (950), so these cases exercise routing rather than the
  // economic floor. The floor itself is exercised in its own describe blocks.
  minAcceptableAmountOut: 900n
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

// An unwrapper whose detection read fails, standing in for a transient RPC failure inside erc4626 /
// Pendle resolution. Records whether it was reached at all.
const throwingUnwrapper = (): Unwrapper & { probed: Address[] } => {
  const probed: Address[] = []
  return {
    kind: 'throwing',
    probed,
    async resolve({ token }) {
      probed.push(token)
      throw new QuoteError('api_error', 'detection read failed')
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
function zeroxBody(buyAmount: string, minBuyAmount = buyAmount) {
  return {
    liquidityAvailable: true,
    buyAmount,
    minBuyAmount,
    transaction: { to: ROUTER, data: '0xabc', value: '0' }
  }
}

// A 1inch-shaped firm-swap body with the given dstAmount. `tx.to` must be the static per-chain
// AggregationRouterV6 — the adapter pins it — so use the real Base router, not the generic ROUTER.
function oneInchBody(dstAmount: string) {
  return { dstAmount, tx: { to: ONEINCH_ROUTER[8453]!, data: '0xdef', value: '0' } }
}

const LIFI_SPENDER = getAddress('0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB')

// A LiFi-shaped firm-quote body with the given toAmount, and an explicit minimum when the case cares
// (LiFi reports its own `toAmountMin`, so a stub returning the full amount overshoots any lower floor).
function lifiBody(toAmount: string, toAmountMin = toAmount) {
  return {
    estimate: { approvalAddress: LIFI_SPENDER, toAmount, toAmountMin },
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

/**
 * A 0x stub that behaves like the real thing: it applies the slippage WE send to ITS OWN quote. That
 * is precisely why deriving the percentage against the oracle reference put the floor too low, so a
 * stub returning a fixed minimum could not have caught it.
 */
const aggregator = (quotes: string[]) => {
  const sent: (Record<string, string> | undefined)[] = []
  const client: RateLimitedClient = {
    getJson: async <T>(args: { searchParams?: Record<string, string> }) => {
      sent.push(args.searchParams)
      const buy = BigInt(quotes[sent.length - 1] ?? quotes.at(-1)!)
      const bps = BigInt(args.searchParams?.slippageBps ?? '0')
      return zeroxBody(buy.toString(), ((buy * (10_000n - bps)) / 10_000n).toString()) as T
    }
  }
  return { client, sent }
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

// `clamped` marks every fake estimate as taken off the probed ladder, which is how a suite asks for
// the pre-curve behaviour: no trustworthy prediction, and the full venue fall-through.
function composeMulti(
  venues: Venue[],
  order: { venue: Venue; expectedOut: bigint }[],
  httpClient: RateLimitedClient,
  options: {
    unwrappers?: readonly Unwrapper[]
    clamped?: boolean
    ageMs?: number
    swapFreeWithoutVenues?: boolean
  } = {}
) {
  const refreshed: { collateral: Address; loan: Address }[] = []
  const selected: {
    pair: { collateral: Address; loan: Address }
    amountIn: bigint
    referenceAmountOut?: bigint
  }[] = []
  const events: { event: string; fields: Record<string, unknown> }[] = []
  const logger: QuoteLogger = {
    info: (event, fields = {}) => events.push({ event, fields }),
    warn: (event, fields = {}) => events.push({ event, fields })
  }
  const quoting = composeMultiVenueQuoting({
    httpClient,
    chainId: 8453,
    executor: EXECUTOR,
    initiatingEoa: EOA,
    venues,
    baseUrls: {},
    maxRouteImpactBps: 500, // floor = 950
    unwrappers: options.unwrappers ?? [],
    swapFreeWithoutVenues: options.swapFreeWithoutVenues ?? false,
    refresh: async pair => {
      refreshed.push(pair)
    },
    // Mirrors the real selector: one interpolated output per venue, with the cost derived from the
    // caller's own reference at read time (see createVenueSelector).
    select: (pair, amountIn, referenceAmountOut) => {
      selected.push({ pair, amountIn, referenceAmountOut })
      return order.map(({ venue, expectedOut }) => {
        const raw = routeCostBps({ reference: referenceAmountOut, amountOut: expectedOut })
        return {
          venue,
          estimatedOut: expectedOut,
          costBps: raw === null ? null : Math.max(raw, 0),
          costBpsRaw: raw,
          clamped: options.clamped ?? false,
          ageMs: options.ageMs ?? 0
        }
      })
    },
    logger
  })
  return { ...quoting, refreshed, selected, events }
}

describe('composeMultiVenueQuoting', () => {
  it('returns no_config (no API call) when no venues are enabled', async () => {
    const { quoteFor } = composeMulti([], [], multiHttp({}))
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'no_config', firmCalls: 0 })
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
      ['0x', 'lifi'],
      [
        { venue: '0x', expectedOut: 900n },
        { venue: 'lifi', expectedOut: 990n }
      ],
      // 0x quotes 900 (< floor 950) → fall through; lifi quotes 990 (≥ 950) → win. The runner-up is
      // lifi rather than 1inch because 1inch only RECONSTRUCTS its min-out, so it can never satisfy an
      // enforced economic floor (see Swap.minOutSource).
      multiHttp({ '0x': zeroxBody('900'), lifi: lifiBody('990') }),
      // Clamped, so the ranking is untrustworthy and the walk keeps its full fall-through.
      { clamped: true }
    )
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    expect(finalSpender(outcome)).toBe(LIFI_SPENDER)
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
    expect(await quoteFor(REQUEST)).toEqual({
      kind: 'failed',
      reason: 'rate_limited',
      firmCalls: 1
    })
  })

  it('maps an unwrapper error to a failed outcome', async () => {
    const broken: Unwrapper = {
      kind: 'broken',
      resolve: async () => {
        throw new QuoteError('api_error', 'probe exploded')
      }
    }
    const { quoteFor } = composeMulti(['0x'], [], multiHttp({}), { unwrappers: [broken] })
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'failed', reason: 'api_error', firmCalls: 0 })
  })

  it('route-quality-checks an unwrap-only plan (chain ends in the loan token)', async () => {
    // Output 900 < floor 950 → the oracle sanity check applies to unwrap-only plans too.
    const bad = fakeUnwrapper({ from: COLLATERAL, to: LOAN, out: 900n })
    const { quoteFor } = composeMulti(['0x'], [], multiHttp({}), { unwrappers: [bad] })
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'failed', reason: 'bad_route', firmCalls: 0 })
  })

  // The reviewer's counterexample: an unwrap chain can clear route quality and still land under
  // break-even, because the two thresholds are unrelated. This path never touches a venue, so the
  // venue-side postcondition does not cover it.
  it('holds an unwrap-only plan to the economic floor, not just route quality', async () => {
    // Reference 1000, route-quality floor 950, unwrap worst case 970 — passes route quality.
    const unwrapper = fakeUnwrapper({ from: COLLATERAL, to: LOAN, out: 970n })
    const { quoteFor } = composeMulti(['0x'], [], multiHttp({}), { unwrappers: [unwrapper] })

    // Break-even 960: the chain clears it.
    expect(await quoteFor({ ...REQUEST, minAcceptableAmountOut: 960n })).toMatchObject({
      kind: 'swap'
    })

    // Break-even 990: it does not, and must be refused rather than broadcast with a bound that cannot
    // fund the repay.
    expect(await quoteFor({ ...REQUEST, minAcceptableAmountOut: 990n })).toEqual({
      kind: 'failed',
      reason: 'floor_unmet',
      firmCalls: 0
    })
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
      reason: 'api_error',
      firmCalls: 0
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
      multiHttp({ liquidswap: liquidSwapBody('1000'), '0x': zeroxBody('1000') }),
      { clamped: true }
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
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'failed', reason: 'no_route', firmCalls: 1 })
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
    expect(selected).toEqual([
      { pair: { collateral: UNDERLYING, loan: LOAN }, amountIn: 970n, referenceAmountOut: 1000n }
    ])
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

  it('skips unwrap resolution entirely with no venues and no swap-free path', async () => {
    // The refusal must come BEFORE the unwrap chain: a caller with no swap-free path cannot act on
    // any outcome, so resolving first would spend reads that provably cannot lead to a broadcast.
    const unwrapper = fakeUnwrapper({ from: COLLATERAL, to: UNDERLYING, out: 970n })
    const { quoteFor } = composeMulti([], [], multiHttp({}), { unwrappers: [unwrapper] })
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'no_config', firmCalls: 0 })
    expect(unwrapper.probed).toHaveLength(0)
  })

  it('reports no_config, never failed, when an unwrapper throws with no venues', async () => {
    // `failed` arms per-position backoff where `no_config` does not, so a transient read failure must
    // not push a deliberately unarmed deployment into a suppression state machine it never enters.
    const unwrapper = throwingUnwrapper()
    const { quoteFor } = composeMulti([], [], multiHttp({}), { unwrappers: [unwrapper] })
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'no_config', firmCalls: 0 })
    // The throw never runs: refusing first is what makes it unreachable, which is the fix.
    expect(unwrapper.probed).toHaveLength(0)
  })

  it('still resolves unwraps with no venues when the caller has a swap-free path', async () => {
    // Midnight's posture: the unwrap chain is what decides whether a venue is needed at all, so a
    // bad-debt-only deployment resolves it. A chain ending elsewhere than the loan token still needs
    // a venue, so the outcome is unchanged; only the probing is.
    const unwrapper = fakeUnwrapper({ from: COLLATERAL, to: UNDERLYING, out: 970n })
    const { quoteFor } = composeMulti([], [], multiHttp({}), {
      unwrappers: [unwrapper],
      swapFreeWithoutVenues: true
    })
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'no_config', firmCalls: 0 })
    expect(unwrapper.probed.length).toBeGreaterThan(0)
  })

  it('refuses an unwrap-only chain with no venues, even opted into a swap-free path', async () => {
    // The venue-less exception covers `'no-swap'` only. A chain that merely LANDS on the loan token
    // (a PT-USDC or vault-share collateral in a USDC market) still moves assets, which is more than
    // an ALLOW_BAD_DEBT_ONLY posture promises — and `kind: 'swap'` goes straight to simulate+submit.
    const unwrapper = fakeUnwrapper({ from: COLLATERAL, to: LOAN, out: 1000n })
    const { quoteFor } = composeMulti([], [], throwingHttp, {
      unwrappers: [unwrapper],
      swapFreeWithoutVenues: true
    })
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'no_config', firmCalls: 0 })
  })

  it('still takes that same unwrap-only chain when a venue IS enabled', async () => {
    // The other half of the pin: only the venue-less case narrowed. An armed deployment keeps the
    // unwrap-only plan it always built, without spending a venue call on a path with nothing to sell.
    const unwrapper = fakeUnwrapper({ from: COLLATERAL, to: LOAN, out: 1000n })
    const { quoteFor } = composeMulti(['0x'], [], throwingHttp, { unwrappers: [unwrapper] })
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') expect(outcome.plan.steps).toHaveLength(1)
  })

  describe('collateral token IS the loan token (loan-as-collateral)', () => {
    // referenceAmountOut === amountIn === 1000 in REQUEST, which is what an identity oracle at
    // price 1e36 produces, so these cases are the live loan-as-collateral shape.
    const SELF: QuoteRequest = { ...REQUEST, collateralToken: LOAN }

    it('returns a zero-step plan without probing or quoting any venue', async () => {
      const { quoteFor, refreshed, selected } = composeMulti(
        ['0x', '1inch'],
        [{ venue: '0x', expectedOut: 1000n }],
        throwingHttp // any venue call at all would surface as a rate_limited failure
      )
      const outcome = await quoteFor(SELF)
      expect(outcome).toEqual({
        kind: 'swap',
        plan: { steps: [], expectedAmountOut: 1000n, amountOutMinimum: 1000n },
        firmCalls: 0
      })
      expect(refreshed).toHaveLength(0)
      expect(selected).toHaveLength(0)
    })

    it('resolves with NO venues enabled when the caller opted into a swap-free path', async () => {
      // The point of moving the gate: a keyless / bad-debt-only deployment must still clear these.
      const { quoteFor } = composeMulti([], [], throwingHttp, { swapFreeWithoutVenues: true })
      const outcome = await quoteFor(SELF)
      expect(outcome.kind).toBe('swap')
      if (outcome.kind === 'swap') expect(outcome.plan.steps).toHaveLength(0)
    })

    it('refuses with NO venues enabled when the caller has no swap-free path', async () => {
      // The safety invariant behind a detection-only deployment: with the venues gone it must hand
      // back nothing actionable, because its caller takes `kind: 'swap'` straight to simulate+submit.
      // Opting in is what arms this path, so the default must never produce a broadcastable plan.
      const { quoteFor } = composeMulti([], [], throwingHttp)
      expect(await quoteFor(SELF)).toEqual({ kind: 'no_config', firmCalls: 0 })
    })

    it('does not consult the unwrappers — the sell path is already over', async () => {
      const unwrapper = fakeUnwrapper({ from: LOAN, to: UNDERLYING, out: 1000n })
      const { quoteFor } = composeMulti(['0x'], [], throwingHttp, { unwrappers: [unwrapper] })
      expect((await quoteFor(SELF)).kind).toBe('swap')
      expect(unwrapper.probed).toHaveLength(0)
    })

    it('fails closed on an oracle that is not 1:1 (route quality)', async () => {
      // The only way a zero-step plan can be a bad route: the identity oracle disagrees with itself.
      // floor = 950, so a reference of 1100 puts the seize 13.6% under its own oracle value.
      const { quoteFor } = composeMulti(['0x'], [], throwingHttp)
      expect(await quoteFor({ ...SELF, referenceAmountOut: 1100n })).toEqual({
        kind: 'failed',
        reason: 'bad_route',
        firmCalls: 0
      })
    })

    it('fails closed when the seize cannot cover its own break-even repay', async () => {
      const { quoteFor } = composeMulti(['0x'], [], throwingHttp)
      expect(await quoteFor({ ...SELF, minAcceptableAmountOut: 1001n })).toEqual({
        kind: 'failed',
        reason: 'floor_unmet',
        firmCalls: 0
      })
    })

    it('passes at exact break-even, the near-maturity rounding case', async () => {
      // Post-maturity the two ceil divisions can make impliedRepaidUnits === seizedAssets exactly.
      // The floor is `>=`, so break-even passes and the liquidation is attempted for zero surplus.
      const { quoteFor } = composeMulti(['0x'], [], throwingHttp)
      expect((await quoteFor({ ...SELF, minAcceptableAmountOut: 1000n })).kind).toBe('swap')
    })
  })
})

// Every case here reads the FALLBACK derivation, so the curve is clamped throughout: the percentage
// under test is the one derived against the oracle reference, which is what a venue is asked for when
// the probe has no trustworthy prediction of its output.
describe('correlation fields', () => {
  // These carry the position join key and the candidate discriminator across the pipeline stages, so
  // a maturity's events group without normalization. Correlation only — never parsed, never branched on.
  const correlated: QuoteRequest = {
    ...REQUEST,
    id: '0xabc:0x1111111111111111111111111111111111111111',
    candidate: { collateralIndex: 2, postMaturityMode: true }
  }

  it('spreads the candidate discriminator beside the id on every quote event', async () => {
    const { quoteFor, events } = composeMulti(
      ['0x'],
      [{ venue: '0x', expectedOut: 1000n }],
      multiHttp({ '0x': zeroxBody('1000') })
    )
    await quoteFor(correlated)
    const selectOk = events.find(e => e.event === 'select.ok')
    expect(selectOk?.fields).toMatchObject({
      id: correlated.id,
      collateralIndex: 2,
      postMaturityMode: true
    })
  })

  it('never lets the discriminator shadow the join key', async () => {
    // The discriminator is caller-supplied, so a key collision must not be able to rewrite `id` —
    // that would resurrect exactly the split this field set exists to remove.
    const { quoteFor, events } = composeMulti(
      ['0x'],
      [{ venue: '0x', expectedOut: 1000n }],
      multiHttp({ '0x': zeroxBody('1000') })
    )
    await quoteFor({ ...correlated, candidate: { ...correlated.candidate, id: 'spoofed' } })
    expect(events.find(e => e.event === 'select.ok')?.fields?.id).toBe(correlated.id)
  })

  it('reaches the unwrap hops, so a per-hop diagnostic is attributable', async () => {
    const seen: (Record<string, unknown> | undefined)[] = []
    const probe: Unwrapper = {
      kind: 'probe',
      resolve: async ({ correlation }) => {
        seen.push(correlation)
        return null
      }
    }
    const { quoteFor } = composeMulti(
      ['0x'],
      [{ venue: '0x', expectedOut: 1000n }],
      multiHttp({ '0x': zeroxBody('1000') }),
      { unwrappers: [probe] }
    )
    await quoteFor(correlated)
    expect(seen[0]).toEqual({
      collateralIndex: 2,
      postMaturityMode: true,
      id: correlated.id
    })
  })
})

describe('economic min-out floor', () => {
  // Captures the slippage each venue was asked for, which is the aggregators' ONLY min-out lever.
  const capturingHttp = (body: unknown) => {
    const calls: { searchParams?: Record<string, string> }[] = []
    const client: RateLimitedClient = {
      getJson: async <T>(args: { searchParams?: Record<string, string> }) => {
        calls.push(args)
        return body as T
      }
    }
    return { client, calls }
  }

  // 0x is the venue under test here because it takes a PERCENTAGE, which is what this derivation
  // produces. 1inch takes an absolute `minReturn` and so never exercises it.
  const quoteWith = async (request: QuoteRequest, body: unknown) => {
    const { client, calls } = capturingHttp(body)
    const { quoteFor } = composeMulti(['0x'], [{ venue: '0x', expectedOut: 1000n }], client, {
      clamped: true
    })
    await quoteFor(request)
    return { calls }
  }

  it('derives the allowance from break-even, replacing the operator percentage', async () => {
    // reference 1000, break-even 900 -> the route may give up 100/1000 = 1000bps = 10%.
    const { calls } = await quoteWith(
      { ...REQUEST, minAcceptableAmountOut: 900n },
      zeroxBody('1000')
    )
    expect(calls[0]?.searchParams?.slippageBps).toBe('1000')
  })

  it('asks for zero slippage when break-even is the whole reference', async () => {
    const { calls } = await quoteWith(
      { ...REQUEST, minAcceptableAmountOut: 1000n },
      zeroxBody('1000')
    )
    expect(calls[0]?.searchParams?.slippageBps).toBe('0')
  })

  it('clamps a floor above the reference rather than asking for negative slippage', async () => {
    const { calls } = await quoteWith(
      { ...REQUEST, minAcceptableAmountOut: 1200n },
      zeroxBody('1000')
    )
    // The clamp is arithmetic only — a percentage cannot express a floor above its own denominator. It
    // does NOT lower what is accepted: the postcondition still requires the requested 1200.
    expect(calls[0]?.searchParams?.slippageBps).toBe('0')
  })

  // The finding this change exists for: a FIXED allowance is wrong in both directions and crosses
  // over as the protocol's incentive grows, while a break-even-derived one is right at both ends.
  it('tracks the incentive across the ramp where a fixed percentage cannot', async () => {
    const REFERENCE = 10_000n
    const early = await quoteWith(
      { ...REQUEST, referenceAmountOut: REFERENCE, minAcceptableAmountOut: 9985n },
      zeroxBody('10000')
    )
    const late = await quoteWith(
      { ...REQUEST, referenceAmountOut: REFERENCE, minAcceptableAmountOut: 9580n },
      zeroxBody('10000')
    )

    // Early (15bps of incentive) the allowance is FAR tighter than the operator's 1%: a fixed 1%
    // would sit below break-even and let a shortfall through to fail at the repay instead.
    expect(early.calls[0]?.searchParams?.slippageBps).toBe('15')
    // Late (420bps) it is FAR looser: a fixed 1% would sit above break-even and reject fills that
    // would have settled profitably.
    expect(late.calls[0]?.searchParams?.slippageBps).toBe('420')
  })
})

// The defect these cover: the aggregators apply the slippage percentage to THEIR OWN quote, which sits
// under the oracle reference by the execution cost. A percentage derived against the reference lands
// their min-out BELOW break-even, so a drifted fill clears the router and then reverts at the
// protocol's repay pull — the exact failure the floor exists to prevent. The earlier tests asserted
// only the percentage sent, which is why this escaped them.
describe('aggregator min-out actually clears break-even', () => {
  const REFERENCE = 10_000n
  const FLOOR = 9_580n

  // Clamped: these pin the two-pass fallback, where the first pass can only guess the venue's own
  // output from the oracle reference. The one-call path a trustworthy curve unlocks is its own suite.
  const quoteVia = async (client: RateLimitedClient, expectedOut: bigint) =>
    composeMulti(['0x'], [{ venue: '0x', expectedOut }], client, { clamped: true }).quoteFor({
      ...REQUEST,
      referenceAmountOut: REFERENCE,
      minAcceptableAmountOut: FLOOR
    })

  it('re-derives against the venue quote so the floor is not undercut', async () => {
    const { client, sent } = aggregator(['9700', '9700'])
    const outcome = await quoteVia(client, 9700n)

    expect(outcome.kind).toBe('swap')
    if (outcome.kind !== 'swap') return
    // 420bps against the reference, applied to 9700, floors at 9292 — 288 units BELOW break-even. The
    // second pass asks 123bps against the quote instead.
    expect(sent[0]?.slippageBps).toBe('420')
    expect(sent[1]?.slippageBps).toBe('123')
    expect(outcome.plan.amountOutMinimum).toBeGreaterThanOrEqual(FLOOR)
  })

  // The case the previous revision missed: the retry is derived from the FIRST quote's output, so a
  // second quote that comes back lower puts its minimum back under the floor. The retry is only an
  // attempt — the postcondition is the guarantee.
  it('refuses the venue when the re-quote drifts down and still misses the floor', async () => {
    const { client, sent } = aggregator(['9700', '9600'])
    const outcome = await quoteVia(client, 9700n)

    expect(sent).toHaveLength(2)
    // 9600 · 9877/10000 = 9481, which is 99 units under break-even.
    expect(outcome).toEqual({ kind: 'failed', reason: 'floor_unmet', firmCalls: 2 })
  })

  it('reports a re-quote that never answered as the transport failure it is', async () => {
    let call = 0
    const client: RateLimitedClient = {
      getJson: async <T>() => {
        call += 1
        if (call === 2) throw new QuoteError('rate_limited', 'second pass throttled')
        return zeroxBody('9700', '9292') as T
      }
    }
    const outcome = await quoteVia(client, 9700n)

    expect(call).toBe(2)
    // NOT `floor_unmet`: the venue never said its own quote misses the floor — we could not ask it in
    // terms of its own output. An earlier revision kept the first, known-underfloor quote here; the one
    // after it refused it as an economic verdict, which a trusted curve is entitled to stop walking on.
    expect(outcome).toEqual({ kind: 'failed', reason: 'rate_limited', firmCalls: 2 })
  })

  it('spends the second call only when the first floor is short', async () => {
    // Break-even equal to the reference asks zero slippage, so the first minimum already clears it.
    const { client, sent } = aggregator(['10000'])
    const outcome = await composeMulti(['0x'], [{ venue: '0x', expectedOut: 10_000n }], client, {
      clamped: true
    }).quoteFor({
      ...REQUEST,
      referenceAmountOut: REFERENCE,
      minAcceptableAmountOut: REFERENCE
    })

    expect(outcome.kind).toBe('swap')
    expect(sent).toHaveLength(1)
  })

  it('refuses a min-out that is only RECONSTRUCTED, however large it looks', () => {
    // No shipped venue reports a `derived` minimum any more — 1inch moved to an absolute `minReturn` —
    // so this guards the rule directly rather than through a venue. A reconstruction cannot be checked
    // against the floor: doing so compares our own arithmetic with itself.
    const swap = (minOutSource: 'venue' | 'derived'): Swap => ({
      spender: ROUTER,
      target: ROUTER,
      value: 0n,
      callData: '0xabc',
      amountIn: { source: 'fixed', value: 1000n },
      expectedAmountOut: 10_000n,
      amountOutMinimum: 10_000n,
      minOutSource
    })
    expect(clearsFloor(swap('venue'), 9_580n)).toBe(true)
    expect(clearsFloor(swap('derived'), 9_580n)).toBe(false)
    // ...and a venue-reported minimum below the floor is still refused.
    expect(clearsFloor({ ...swap('venue'), amountOutMinimum: 9_579n }, 9_580n)).toBe(false)
  })
})

// A trustworthy curve predicts the venue's own quoted output, which is the denominator the second pass
// above exists to discover. The prediction is biased DOWN by design, and these cases pin BOTH bounds on
// how far the encoded floor may then sit from break-even: too high a prediction is refused by
// `clearsFloor`, too low an one is refused past `MAX_FLOOR_OVERSHOOT_BPS`, and each costs the second
// pass back.
describe('curve-predicted min-out denominator', () => {
  const REFERENCE = 10_000n
  const FLOOR = 9_580n

  // `estimatedOut` is what the curve interpolated; `quotes` is what the venue really answers.
  const quoteWithCurve = async (estimatedOut: bigint, quotes: string[]) => {
    const { client, sent } = aggregator(quotes)
    const outcome = await composeMulti(
      ['0x'],
      [{ venue: '0x', expectedOut: estimatedOut }],
      client
    ).quoteFor({ ...REQUEST, referenceAmountOut: REFERENCE, minAcceptableAmountOut: FLOOR })
    return { outcome, sent }
  }

  it('spends ONE call, floor cleared, when the curve predicts the venue output', async () => {
    // Curve 9700 → prediction 9690 (10bps under), venue really quotes 9700: 113bps against 9690 lands
    // the encoded minimum at 9590, above the 9580 break-even, so the second pass is never needed.
    const { outcome, sent } = await quoteWithCurve(9_700n, ['9700'])

    expect(sent).toHaveLength(1)
    expect(sent[0]?.slippageBps).toBe('113')
    expect(outcome.kind).toBe('swap')
    if (outcome.kind !== 'swap') return
    expect(outcome.plan.amountOutMinimum).toBe(9_590n)
    expect(outcome.plan.amountOutMinimum).toBeGreaterThanOrEqual(FLOOR)
    expect(outcome.firmCalls).toBe(1)
  })

  it('leaves a small overshoot alone: one call, floor a few bps above break-even', async () => {
    // Curve 9690 → prediction 9680, venue quotes 9700: 103bps lands the minimum at 9600, exactly 20 bps
    // over break-even — at the bound, so the overshoot is accepted rather than re-derived.
    const { outcome, sent } = await quoteWithCurve(9_690n, ['9700'])

    expect(sent).toHaveLength(1)
    expect(sent[0]?.slippageBps).toBe('103')
    expect(outcome.kind).toBe('swap')
    if (outcome.kind !== 'swap') return
    expect(outcome.plan.amountOutMinimum).toBe(9_600n)
    expect(outcome.firmCalls).toBe(1)
  })

  it('spends the second pass on an UNDER-estimate too, when the overshoot exceeds the bound', async () => {
    // Curve 9650 → prediction 9640, venue quotes 9700. A denominator under the real quote asks for LESS
    // slippage than break-even needs, so the first pass encodes 9639 — 61.6 bps ABOVE break-even, three
    // times the whole post-maturity incentive. Every fill in that band would revert at send although
    // the repay covered it, so the bound spends the second pass and lands the floor back on break-even.
    const { outcome, sent } = await quoteWithCurve(9_650n, ['9700', '9700'])

    expect(sent).toHaveLength(2)
    expect(sent[0]?.slippageBps).toBe('62')
    expect(sent[1]?.slippageBps).toBe('123')
    expect(outcome.kind).toBe('swap')
    if (outcome.kind !== 'swap') return
    expect(outcome.plan.amountOutMinimum).toBe(FLOOR)
    expect(outcome.firmCalls).toBe(2)
  })

  it('falls back to the second pass on an OVER-estimate, and still clears the floor', async () => {
    // Curve 9900 → prediction 9890, above the venue's real 9700: 313bps lands the minimum at 9396,
    // 184 units UNDER break-even. The postcondition refuses it and pass 2 re-derives against 9700.
    const { outcome, sent } = await quoteWithCurve(9_900n, ['9700', '9700'])

    expect(sent).toHaveLength(2)
    expect(sent[0]?.slippageBps).toBe('313')
    expect(sent[1]?.slippageBps).toBe('123')
    expect(outcome.kind).toBe('swap')
    if (outcome.kind !== 'swap') return
    expect(outcome.plan.amountOutMinimum).toBeGreaterThanOrEqual(FLOOR)
    expect(outcome.firmCalls).toBe(2)
  })

  it('keeps the overshooting first quote when the re-quote drifts down under the floor', async () => {
    // The overshoot second pass is an IMPROVEMENT the venue may decline: the first quote was already
    // usable, so a re-quote that came back lower must not turn an expensive fill into no fill.
    const { outcome, sent } = await quoteWithCurve(9_650n, ['9700', '9500'])

    expect(sent).toHaveLength(2)
    expect(outcome.kind).toBe('swap')
    if (outcome.kind !== 'swap') return
    expect(outcome.plan.amountOutMinimum).toBe(9_639n)
    expect(outcome.firmCalls).toBe(2)
  })

  it('keeps the overshooting first quote when the re-quote fails outright', async () => {
    let call = 0
    const client: RateLimitedClient = {
      getJson: async <T>() => {
        call += 1
        if (call === 2) throw new QuoteError('rate_limited', 'second pass throttled')
        return zeroxBody('9700', '9639') as T
      }
    }
    const outcome = await composeMulti(
      ['0x'],
      [{ venue: '0x', expectedOut: 9_650n }],
      client
    ).quoteFor({ ...REQUEST, referenceAmountOut: REFERENCE, minAcceptableAmountOut: FLOOR })

    expect(call).toBe(2)
    expect(outcome.kind).toBe('swap')
    if (outcome.kind !== 'swap') return
    expect(outcome.plan.amountOutMinimum).toBe(9_639n)
  })

  it('ignores an estimate older than the prediction age bound', async () => {
    // Ordering survives any cache age, but a min-out denominator consumes the absolute level. A bot
    // whose probe TTL is minutes (blue's is ten) must not thereby encode a minutes-old denominator.
    const { client, sent } = aggregator(['9700', '9700'])
    const outcome = await composeMulti(['0x'], [{ venue: '0x', expectedOut: 9_700n }], client, {
      ageMs: 60_001
    }).quoteFor({ ...REQUEST, referenceAmountOut: REFERENCE, minAcceptableAmountOut: FLOOR })

    // 420bps against the reference, exactly as before the curve existed.
    expect(sent).toHaveLength(2)
    expect(sent[0]?.slippageBps).toBe('420')
    expect(outcome.kind).toBe('swap')
  })

  it('ignores a clamped estimate, restoring the pre-curve two-pass derivation', async () => {
    const { client, sent } = aggregator(['9700', '9700'])
    const outcome = await composeMulti(['0x'], [{ venue: '0x', expectedOut: 9_700n }], client, {
      clamped: true
    }).quoteFor({ ...REQUEST, referenceAmountOut: REFERENCE, minAcceptableAmountOut: FLOOR })

    // 420bps against the reference, exactly as before the curve existed.
    expect(sent).toHaveLength(2)
    expect(sent[0]?.slippageBps).toBe('420')
    expect(outcome.kind).toBe('swap')
  })
})

describe('venue fall-through cap', () => {
  it('quotes only the winner when the curve ranked every enabled venue', async () => {
    // The same books as the fall-through case, minus the clamp: 0x loses on route quality and lifi
    // WOULD have won, but a complete unclamped curve already named the winner. `firmCalls: 1` is the
    // proof that lifi was never asked.
    const { quoteFor } = composeMulti(
      ['0x', 'lifi'],
      [
        { venue: '0x', expectedOut: 900n },
        { venue: 'lifi', expectedOut: 990n }
      ],
      multiHttp({ '0x': zeroxBody('900'), lifi: lifiBody('990') })
    )
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'failed', reason: 'bad_route', firmCalls: 1 })
  })

  it('still falls through when the WINNER is unreachable: the curve ranked output, not uptime', async () => {
    // A complete unclamped curve, so the walk would normally stop at 0x. But 0x has no stub and throws
    // `no_route` — a transport-class failure the ranking says nothing about, unlike `bad_route` or
    // `floor_unmet`. Capping here would lose a liquidation lifi could have filled, so the walk goes on.
    const { quoteFor } = composeMulti(
      ['0x', 'lifi'],
      [
        { venue: '0x', expectedOut: 1000n },
        { venue: 'lifi', expectedOut: 990n }
      ],
      // The runner-up's own minimum lands on break-even, as a real venue's does for the slippage it
      // was asked for, so its quote costs exactly one call.
      multiHttp({ lifi: lifiBody('990', '900') })
    )
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    expect(finalSpender(outcome)).toBe(LIFI_SPENDER)
    // Both requests were issued: the winner's throw plus the runner-up's success.
    expect(outcome.firmCalls).toBe(2)
  })

  it('still falls through when the min-out RE-QUOTE fails on a trusted curve', async () => {
    // The winner's own quote never said it misses the floor: the request that would have asked it in
    // its own terms failed. Classifying that as `floor_unmet` let a transient 429 on the SECOND pass
    // stop the walk and lose a liquidation the runner-up could have filled — the one thing the curve
    // was never allowed to cost.
    let zeroxCalls = 0
    const client: RateLimitedClient = {
      getJson: async <T>(args: { venue: HttpVenue }) => {
        if (args.venue === 'lifi') return lifiBody('9700', '9580') as T
        zeroxCalls += 1
        if (zeroxCalls === 1) return zeroxBody('9700', '9396') as T
        throw new QuoteError('rate_limited', 're-quote throttled')
      }
    }
    const { quoteFor } = composeMulti(
      ['0x', 'lifi'],
      [
        { venue: '0x', expectedOut: 9_900n },
        { venue: 'lifi', expectedOut: 9_700n }
      ],
      client
    )
    const outcome = await quoteFor({
      ...REQUEST,
      referenceAmountOut: 10_000n,
      minAcceptableAmountOut: 9_580n
    })

    expect(zeroxCalls).toBe(2)
    expect(outcome.kind).toBe('swap')
    expect(finalSpender(outcome)).toBe(LIFI_SPENDER)
  })

  it('counts every call of a multi-venue walk that ends in failure', async () => {
    const { quoteFor } = composeMulti(
      ['0x', 'lifi'],
      [
        { venue: '0x', expectedOut: 900n },
        { venue: 'lifi', expectedOut: 900n }
      ],
      multiHttp({ '0x': zeroxBody('900'), lifi: lifiBody('900') }),
      { clamped: true }
    )
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'failed', reason: 'bad_route', firmCalls: 2 })
  })

  it('reports the probe-fidelity pair and the call count on select.ok', async () => {
    const { quoteFor, events } = composeMulti(
      ['0x'],
      [{ venue: '0x', expectedOut: 9_700n }],
      multiHttp({ '0x': zeroxBody('9600') })
    )
    const outcome = await quoteFor({
      ...REQUEST,
      referenceAmountOut: 10_000n,
      minAcceptableAmountOut: 9_580n
    })

    expect(outcome.kind).toBe('swap')
    // The curve interpolated 9700 against a 10000 reference (300bps); the firm quote came back at
    // 9600 (400bps). Both are quoted costs — the pair is what makes probe fidelity measurable.
    expect(events.find(entry => entry.event === 'select.ok')?.fields).toMatchObject({
      venue: '0x',
      curveCostBps: 300,
      curveAgeMs: 0,
      firmQuoteCostBps: 400,
      firmCalls: 1
    })
  })
})
