import type { Logger } from '@repo/evm-kit'
import type { RateLimitedClient, VenuePair, VenueQuoteEstimate, VenueSelector } from '@repo/swaps'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { Market } from '../src/execution/encode-call'
import type { LiquidationPlan } from '../src/sizing/plan'
import type { LensOut } from '../src/state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../src/constants'
import { composeQuoting } from '../src/quotes'

// The Midnight-shaped adapter over @repo/swaps' composeMultiVenueQuoting: these cases pin the LENS
// PROJECTION (out.market.collateralParams[plan.collateralIndex] → QuoteRequest), the missing-slot and
// excluded-collateral short-circuits, and that a probe is refreshed for the pair before quoting.

const NOOP_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const ORACLE = getAddress('0x8888888888888888888888888888888888888888')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const TARGET = getAddress('0x5555555555555555555555555555555555555555')
const ZERO = getAddress('0x0000000000000000000000000000000000000000')

const MARKET: Market = {
  chainId: 8453n,
  midnight: getAddress('0x2222222222222222222222222222222222222222'),
  loanToken: LOAN,
  collateralParams: [
    {
      token: COLLATERAL,
      lltv: (WAD * 86n) / 100n,
      liquidationCursor: 3n * 10n ** 17n,
      oracle: ORACLE
    }
  ],
  maturity: 2n ** 64n - 1n,
  rcfThreshold: 0n,
  enterGate: ZERO,
  liquidatorGate: ZERO
}

// price = ORACLE_PRICE_SCALE → expectedLoanOut = seizedAssets = 1000 (the route-quality reference).
const PLAN: LiquidationPlan = {
  collateralIndex: 0,
  seizedAssets: 1000n,
  repaidUnits: 900n,
  postMaturityMode: false
}

const OUT: LensOut = {
  valid: true,
  hasDebt: true,
  healthy: false,
  locked: false,
  gateAllows: true,
  blockTimestamp: 1000n,
  debt: 900n,
  maxDebt: 800n,
  badDebt: 0n,
  activatedBitmap: 1n,
  bestCollateralIdx: 0,
  bestCollateralAmt: 1000n,
  bestCollateralPrice: ORACLE_PRICE_SCALE,
  bestCollateralMaxLif: WAD,
  bestCollateralLltv: (WAD * 86n) / 100n,
  market: MARKET
}

// A 0x firm-quote body whose buyAmount is at/above the route-quality floor.
const OK_ZEROX_BODY = {
  liquidityAvailable: true,
  buyAmount: '1000',
  minBuyAmount: '995',
  transaction: { to: TARGET, data: '0xabc', value: '0' }
}
const httpStub: RateLimitedClient = { getJson: async <T>() => OK_ZEROX_BODY as T }

// A selector stub: records which pairs were refreshed and returns a fixed best-first order.
function fakeSelector(order: VenueQuoteEstimate[], onRefresh?: () => Promise<void>) {
  const refreshed: VenuePair[] = []
  const selector: VenueSelector = {
    refresh: async pair => {
      refreshed.push(pair)
      if (onRefresh) await onRefresh()
    },
    select: () => order,
    snapshot: () => [],
    dump: () => ({ pairs: [], decimals: [] })
  }
  return { selector, refreshed }
}

function compose(
  selector: VenueSelector,
  overrides: { venues?: ('0x' | '1inch')[]; excludeCollaterals?: `0x${string}`[] } = {}
) {
  return composeQuoting({
    httpClient: httpStub,
    selector,
    chainId: 8453,
    executor: EXECUTOR,
    venues: overrides.venues ?? ['0x'],
    slippageBps: 100,
    baseUrls: {},
    maxRouteImpactBps: 500,
    excludeCollaterals: overrides.excludeCollaterals ?? [],
    logger: NOOP_LOGGER
  })
}

describe('composeQuoting (Midnight lens-projection adapter)', () => {
  it('returns no_config when the plan indexes a missing collateral slot', async () => {
    const { selector, refreshed } = fakeSelector([{ venue: '0x', expectedOut: 1000n }])
    const { quoteFor } = compose(selector)
    expect(await quoteFor({ ...PLAN, collateralIndex: 5 }, OUT)).toEqual({ kind: 'no_config' })
    expect(refreshed).toHaveLength(0) // never probed for a slot it can't route
  })

  it('returns no_config (and never probes) for an excluded collateral', async () => {
    const { selector, refreshed } = fakeSelector([{ venue: '0x', expectedOut: 1000n }])
    const { quoteFor } = compose(selector, { excludeCollaterals: [COLLATERAL] })
    expect(await quoteFor(PLAN, OUT)).toEqual({ kind: 'no_config' })
    expect(refreshed).toHaveLength(0)
  })

  it('refreshes the pair probe, then projects into an executable swap from the ranked venue', async () => {
    const { selector, refreshed } = fakeSelector([{ venue: '0x', expectedOut: 1000n }])
    const { quoteFor } = compose(selector)
    const outcome = await quoteFor(PLAN, OUT)

    expect(refreshed).toEqual([{ collateral: COLLATERAL, loan: LOAN }])
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') {
      expect(outcome.swap.target).toBe(TARGET)
      expect(outcome.swap.expectedAmountOut).toBe(1000n)
    }
  })

  it('still quotes (cold-default) when the probe refresh throws', async () => {
    // Cold cache (select → []) + a refresh that rejects → the firm-quote step falls back to the
    // deterministic enabled-venue order rather than failing the position.
    const { selector } = fakeSelector([], async () => {
      throw new Error('probe boom')
    })
    const { quoteFor } = compose(selector)
    expect((await quoteFor(PLAN, OUT)).kind).toBe('swap')
  })

  it('returns no_config when no venues are enabled (bad-debt-only posture)', async () => {
    const { selector } = fakeSelector([])
    const { quoteFor } = compose(selector, { venues: [] })
    expect(await quoteFor(PLAN, OUT)).toEqual({ kind: 'no_config' })
  })
})
