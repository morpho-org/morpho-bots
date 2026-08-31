import type { Logger } from '@repo/bot-kit'
import type { RateLimitedClient, Venue, VenuePair, VenueSelector } from '@repo/swaps'

import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { Market } from '../src/execution/encode-call'
import type { LiquidationPlan } from '../src/sizing/plan'
import type { LensOut } from '../src/state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../src/constants'
import { composeQuoting } from '../src/quotes'

// The Midnight-shaped adapter over @repo/swaps' composeMultiVenueQuoting: these cases pin the LENS
// PROJECTION (out.market.collateralParams[plan.collateralIndex] → QuoteRequest), the missing-slot and
// excluded-collateral short-circuits, and that a probe is refreshed for the pair before quoting.

const NOOP_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

// The position label the tick threads as the QuoteRequest correlation id (`${id}:${borrower}`).
const LABEL = '0xabc:0x9999999999999999999999999999999999999999'

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
  postMaturityMode: false,
  // lif 1.25 puts break-even at exactly 800, under the 0x stub's reported min-out of 995, so these
  // projection cases exercise the lens mapping rather than the economic floor.
  lif: (WAD * 5n) / 4n,
  impliedRepaidUnits: 800n,
  oraclePrice: ORACLE_PRICE_SCALE,
  swapFree: false
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
  collaterals: [
    { index: 0, amt: 1000n, price: ORACLE_PRICE_SCALE, maxLif: WAD, lltv: (WAD * 86n) / 100n }
  ],
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
function fakeSelector(order: Venue[], onRefresh?: () => Promise<void>) {
  const refreshed: VenuePair[] = []
  const selector: VenueSelector = {
    refresh: async pair => {
      refreshed.push(pair)
      if (onRefresh) await onRefresh()
    },
    select: () =>
      order.map(venue => ({ venue, estimatedOut: 1000n, costBps: null, clamped: false })),
    snapshot: () => []
  }
  return { selector, refreshed }
}

function compose(
  selector: VenueSelector,
  overrides: {
    venues?: ('0x' | '1inch')[]
    excludeCollaterals?: `0x${string}`[]
    logger?: Logger
    httpClient?: RateLimitedClient
  } = {}
) {
  return composeQuoting({
    httpClient: overrides.httpClient ?? httpStub,
    selector,
    chainId: 8453,
    executor: EXECUTOR,
    venues: overrides.venues ?? ['0x'],
    baseUrls: {},
    maxRouteImpactBps: 500,
    unwrappers: [],
    excludeCollaterals: overrides.excludeCollaterals ?? [],
    logger: overrides.logger ?? NOOP_LOGGER
  })
}

describe('composeQuoting (Midnight lens-projection adapter)', () => {
  it('returns no_config when the plan indexes a missing collateral slot', async () => {
    const { selector, refreshed } = fakeSelector(['0x'])
    const { quoteFor } = compose(selector)
    expect(await quoteFor({ ...PLAN, collateralIndex: 5 }, OUT, LABEL)).toEqual({
      kind: 'no_config'
    })
    expect(refreshed).toHaveLength(0) // never probed for a slot it can't route
  })

  it('returns no_config (and never probes) for an excluded collateral', async () => {
    const { selector, refreshed } = fakeSelector(['0x'])
    const { quoteFor } = compose(selector, { excludeCollaterals: [COLLATERAL] })
    expect(await quoteFor(PLAN, OUT, LABEL)).toEqual({ kind: 'no_config' })
    expect(refreshed).toHaveLength(0)
  })

  it('refreshes the pair probe, then projects into an executable swap from the ranked venue', async () => {
    const { selector, refreshed } = fakeSelector(['0x'])
    const { quoteFor } = compose(selector)
    const outcome = await quoteFor(PLAN, OUT, LABEL)

    expect(refreshed).toEqual([{ collateral: COLLATERAL, loan: LOAN }])
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') {
      expect(outcome.plan.steps).toHaveLength(1)
      expect(outcome.plan.steps[0]?.target).toBe(TARGET)
      expect(outcome.plan.expectedAmountOut).toBe(1000n)
    }
  })

  it('still quotes (cold-default) when the probe refresh throws', async () => {
    // Cold cache (select → []) + a refresh that rejects → the firm-quote step falls back to the
    // deterministic enabled-venue order rather than failing the position.
    const { selector } = fakeSelector([], async () => {
      throw new Error('probe boom')
    })
    const { quoteFor } = compose(selector)
    expect((await quoteFor(PLAN, OUT, LABEL)).kind).toBe('swap')
  })

  it('returns no_config when no venues are enabled (bad-debt-only posture)', async () => {
    const { selector } = fakeSelector([])
    const { quoteFor } = compose(selector, { venues: [] })
    expect(await quoteFor(PLAN, OUT, LABEL)).toEqual({ kind: 'no_config' })
  })

  it('threads the position label into quote log events as the correlation id', async () => {
    const events: { event: string; fields?: Record<string, unknown> }[] = []
    const capturing: Logger = {
      debug: () => {},
      info: (event, fields) => events.push({ event, fields }),
      warn: () => {},
      error: () => {}
    }
    const { selector } = fakeSelector(['0x'])
    const { quoteFor } = compose(selector, { logger: capturing })
    await quoteFor(PLAN, OUT, LABEL)
    const selectOk = events.find(e => e.event === 'select.ok')
    expect(selectOk?.fields?.id).toBe(LABEL)
  })

  it('projects the plan break-even into the venue slippage it asks for', () => {
    // seizedAssets 1000 at price 1e36 -> reference 1000; break-even 800 -> 2000bps of allowance. Pins
    // that the adapter threads `impliedRepaidUnits` rather than leaving the floor unset.
    const calls: (Record<string, string> | undefined)[] = []
    const capturing: RateLimitedClient = {
      getJson: async <T>(args: { searchParams?: Record<string, string> }) => {
        calls.push(args.searchParams)
        return OK_ZEROX_BODY as T
      }
    }
    const { selector } = fakeSelector(['0x'])
    return compose(selector, { httpClient: capturing })
      .quoteFor(PLAN, OUT, LABEL)
      .then(() => {
        expect(calls[0]?.slippageBps).toBe('2000')
      })
  })
})
