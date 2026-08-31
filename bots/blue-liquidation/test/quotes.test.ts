import type { Logger } from '@repo/bot-kit'
import type { RateLimitedClient, Venue, VenuePair, VenueSelector } from '@repo/swaps'

import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { MarketParams } from '../src/market'
import type { LiquidationPlan } from '../src/sizing/plan'
import type { LensOut } from '../src/state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../src/constants'
import { composeQuoting } from '../src/quotes'

// The Blue-shaped adapter over @repo/swaps' composeMultiVenueQuoting: these cases pin the LENS
// PROJECTION (out.params.* → QuoteRequest), the excluded-collateral short-circuit, and that a probe
// is refreshed for the pair before quoting; the venue/floor behavior itself is tested in the package.

const NOOP_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const ORACLE = getAddress('0x8888888888888888888888888888888888888888')
const IRM = getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const TARGET = getAddress('0x5555555555555555555555555555555555555555')

const PARAMS: MarketParams = {
  loanToken: LOAN,
  collateralToken: COLLATERAL,
  oracle: ORACLE,
  irm: IRM,
  lltv: (WAD * 86n) / 100n
}

// Break-even at 800, under the 0x stub's reported min-out of 995, so these cases exercise the lens
// projection rather than the economic floor (which is covered in @repo/swaps).
const PLAN: LiquidationPlan = { seizedAssets: 1000n, impliedRepaidAssets: 800n }

const OUT: LensOut = {
  params: PARAMS,
  valid: true,
  hasDebt: true,
  healthy: false,
  blockTimestamp: 1000n,
  borrowShares: 2000n,
  collateral: 1000n,
  accruedTotalBorrowAssets: 2000n,
  totalBorrowShares: 2000n,
  collateralPrice: ORACLE_PRICE_SCALE,
  lltv: PARAMS.lltv
}

// A 0x firm-quote body whose buyAmount is at/above the route-quality floor.
const OK_ZEROX_BODY = {
  liquidityAvailable: true,
  buyAmount: '1000',
  minBuyAmount: '995',
  transaction: { to: TARGET, data: '0xabc', value: '0' }
}
const httpStub: RateLimitedClient = { getJson: async <T>() => OK_ZEROX_BODY as T }

// The position label the tick threads as the QuoteRequest correlation id (`${id}:${borrower}`).
const LABEL = '0xabc:0x9999999999999999999999999999999999999999'

// A selector stub: records which pairs were refreshed and returns a fixed best-first order. `clamped`
// makes the curve untrustworthy, which is how a case asks for the oracle-reference min-out derivation
// instead of the curve-predicted one.
function fakeSelector(
  order: Venue[],
  options: { onRefresh?: () => Promise<void>; clamped?: boolean } = {}
) {
  const refreshed: VenuePair[] = []
  const selector: VenueSelector = {
    refresh: async pair => {
      refreshed.push(pair)
      if (options.onRefresh) await options.onRefresh()
    },
    select: () =>
      order.map(venue => ({
        venue,
        estimatedOut: 1000n,
        costBps: null,
        costBpsRaw: null,
        clamped: options.clamped ?? false
      })),
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

describe('composeQuoting (Blue lens-projection adapter)', () => {
  it('returns no_config (and never probes) for an excluded collateral', async () => {
    const { selector, refreshed } = fakeSelector(['0x'])
    const { quoteFor } = compose(selector, { excludeCollaterals: [COLLATERAL] })
    expect(await quoteFor(PLAN, OUT, LABEL)).toEqual({ kind: 'no_config' })
    expect(refreshed).toHaveLength(0)
  })

  it('refreshes the pair probe, then projects out.params into an executable swap', async () => {
    const { selector, refreshed } = fakeSelector(['0x'])
    const { quoteFor } = compose(selector)
    const outcome = await quoteFor(PLAN, OUT, LABEL)

    expect(refreshed).toEqual([{ collateral: COLLATERAL, loan: LOAN }])
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') {
      expect(outcome.plan.steps).toHaveLength(1)
      expect(outcome.plan.steps[0]).toMatchObject({
        tokenIn: COLLATERAL,
        tokenOut: LOAN,
        target: TARGET
      })
      // buyAmount 1000 at the 1e36 oracle price meets the route-quality floor — proving
      // expectedLoanOut(plan, out) was passed as referenceAmountOut.
      expect(outcome.plan.expectedAmountOut).toBe(1000n)
    }
  })

  it('still quotes (cold-default) when the probe refresh throws', async () => {
    // Cold cache (select → []) + a refresh that rejects → the firm-quote step falls back to the
    // deterministic enabled-venue order rather than failing the position.
    const { selector } = fakeSelector([], {
      onRefresh: async () => {
        throw new Error('probe boom')
      }
    })
    const { quoteFor } = compose(selector)
    expect((await quoteFor(PLAN, OUT, LABEL)).kind).toBe('swap')
  })

  it('returns no_config when no venues are enabled (detection-only posture)', async () => {
    const { selector } = fakeSelector([])
    const { quoteFor } = compose(selector, { venues: [] })
    expect(await quoteFor(PLAN, OUT, LABEL)).toEqual({ kind: 'no_config', firmCalls: 0 })
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
    // seizedAssets 1000 at price 1e36 -> reference 1000; break-even 800 -> the route may give up
    // 200/1000 = 2000bps. If the adapter stopped threading `impliedRepaidAssets` this would read 0.
    const calls: (Record<string, string> | undefined)[] = []
    const capturing: RateLimitedClient = {
      getJson: async <T>(args: { searchParams?: Record<string, string> }) => {
        calls.push(args.searchParams)
        return OK_ZEROX_BODY as T
      }
    }
    // Clamped, so the percentage is derived against the oracle reference: the adapter's projection is
    // what is pinned here, not the curve's prediction of the venue's own output.
    const { selector } = fakeSelector(['0x'], { clamped: true })
    return compose(selector, { httpClient: capturing })
      .quoteFor(PLAN, OUT, LABEL)
      .then(() => {
        expect(calls[0]?.slippageBps).toBe('2000')
      })
  })
})
