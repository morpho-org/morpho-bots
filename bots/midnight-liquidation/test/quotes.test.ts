import type { Logger } from '@repo/bot-kit'
import type { RateLimitedClient, Unwrapper, Venue, VenuePair, VenueSelector } from '@repo/swaps'

import { getAddress, isAddressEqual } from 'viem'
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
const EOA = getAddress('0x2222222222222222222222222222222222222222')
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
        clamped: options.clamped ?? false,
        ageMs: 0
      })),
    snapshot: () => []
  }
  return { selector, refreshed }
}

// A collateral that unwraps straight to the loan token (a vault share or PT in a USDC market), with
// the pair-only seam answered separately from the calldata-building half.
const unwrapsToLoan = (): Unwrapper & { resolved: () => number } => {
  let resolved = 0
  return {
    kind: 'fake-erc4626',
    resolved: () => resolved,
    previewTokenOut: async token => (isAddressEqual(token, COLLATERAL) ? LOAN : null),
    async resolve({ token }) {
      resolved += 1
      if (!isAddressEqual(token, COLLATERAL)) return null
      return {
        step: {
          tokenIn: COLLATERAL,
          tokenOut: LOAN,
          target: TARGET,
          value: 0n,
          callData: '0x12345678',
          amountIn: { source: 'balance', offset: 4n }
        },
        expectedAmountOut: 1000n,
        amountOutMinimum: 1000n
      }
    }
  }
}

function compose(
  selector: VenueSelector,
  overrides: {
    venues?: ('0x' | '1inch')[]
    excludeCollaterals?: `0x${string}`[]
    logger?: Logger
    httpClient?: RateLimitedClient
    unwrappers?: readonly Unwrapper[]
  } = {}
) {
  return composeQuoting({
    httpClient: overrides.httpClient ?? httpStub,
    selector,
    chainId: 8453,
    executor: EXECUTOR,
    initiatingEoa: EOA,
    venues: overrides.venues ?? ['0x'],
    baseUrls: {},
    maxRouteImpactBps: 500,
    unwrappers: overrides.unwrappers ?? [],
    excludeCollaterals: overrides.excludeCollaterals ?? [],
    logger: overrides.logger ?? NOOP_LOGGER
  })
}

describe('composeQuoting (Midnight lens-projection adapter)', () => {
  it('returns no_config when the plan indexes a missing collateral slot', async () => {
    const { selector, refreshed } = fakeSelector(['0x'])
    const { quoteFor } = compose(selector)
    // `firmCalls: 0`, not absent: an absent count reads as unknown, and this path provably spent none.
    expect(await quoteFor({ ...PLAN, collateralIndex: 5 }, OUT, LABEL)).toEqual({
      kind: 'no_config',
      firmCalls: 0
    })
    expect(refreshed).toHaveLength(0) // never probed for a slot it can't route
  })

  it('returns no_config (and never probes) for an excluded collateral', async () => {
    const { selector, refreshed } = fakeSelector(['0x'])
    const { quoteFor } = compose(selector, { excludeCollaterals: [COLLATERAL] })
    expect(await quoteFor(PLAN, OUT, LABEL)).toEqual({ kind: 'no_config', firmCalls: 0 })
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
    const { selector } = fakeSelector([], {
      onRefresh: async () => {
        throw new Error('probe boom')
      }
    })
    const { quoteFor } = compose(selector)
    expect((await quoteFor(PLAN, OUT, LABEL)).kind).toBe('swap')
  })

  it('returns no_config when no venues are enabled (bad-debt-only posture)', async () => {
    const { selector } = fakeSelector([])
    const { quoteFor } = compose(selector, { venues: [] })
    expect(await quoteFor(PLAN, OUT, LABEL)).toEqual({ kind: 'no_config', firmCalls: 0 })
  })

  it('still clears a loan-as-collateral slot with no venues enabled', async () => {
    // Midnight's `swapFreeWithoutVenues` opt-in, which is what keeps these liquidatable under
    // ALLOW_BAD_DEBT_ONLY: the seize is already the loan token, so it needs no route and the
    // package's default refusal must not apply. Blue deliberately leaves the flag off.
    const selfMarket: Market = {
      ...MARKET,
      collateralParams: [{ ...MARKET.collateralParams[0]!, token: LOAN }]
    }
    const { selector } = fakeSelector([])
    const { quoteFor } = compose(selector, { venues: [] })
    const outcome = await quoteFor(
      { ...PLAN, swapFree: true },
      { ...OUT, market: selfMarket },
      LABEL
    )
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') expect(outcome.plan.steps).toHaveLength(0)
  })

  it('refuses an unwrap-only collateral with no venues, despite the swap-free opt-in', async () => {
    // `swapFreeWithoutVenues` arms the zero-step shape only. A chain that merely LANDS on the loan
    // token still moves assets, which is broader than `ALLOW_BAD_DEBT_ONLY` promises.
    const unwrapper = unwrapsToLoan()
    const { selector } = fakeSelector([])
    const { quoteFor } = compose(selector, { venues: [], unwrappers: [unwrapper] })
    expect(await quoteFor(PLAN, OUT, LABEL)).toEqual({ kind: 'no_config', firmCalls: 0 })
  })

  it('still takes that unwrap-only collateral when a venue is enabled', async () => {
    const unwrapper = unwrapsToLoan()
    const { selector } = fakeSelector(['0x'])
    const { quoteFor } = compose(selector, { unwrappers: [unwrapper] })
    const outcome = await quoteFor(PLAN, OUT, LABEL)
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') expect(outcome.plan.steps).toHaveLength(1)
  })

  it('resolveRoute previews the pair without building calldata', async () => {
    // The seam's whole point: for a Pendle PT, `resolve` is a rate-limited hosted request whose
    // calldata phase A.5 discards and the firm quote then re-fetches.
    const unwrapper = unwrapsToLoan()
    const { selector } = fakeSelector(['0x'])
    const { resolveRoute } = compose(selector, { unwrappers: [unwrapper] })
    // Ends on the loan token, so there is no pair left to probe.
    expect(await resolveRoute(PLAN, OUT, LABEL)).toBeNull()
    expect(unwrapper.resolved()).toBe(0)
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

  it('threads the candidate discriminator, so two candidates of one position stay separable', async () => {
    // The swaps-side gap BOTS-90 leaves otherwise: both candidates carry one `id`, so without the
    // discriminator their `select.ok` rows are indistinguishable.
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
    await quoteFor({ ...PLAN, postMaturityMode: true }, OUT, LABEL)
    const rows = events.filter(e => e.event === 'select.ok')
    expect(rows.map(e => e.fields?.id)).toEqual([LABEL, LABEL])
    expect(rows.map(e => e.fields?.collateralIndex)).toEqual([0, 0])
    expect(rows.map(e => e.fields?.postMaturityMode)).toEqual([false, true])
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
