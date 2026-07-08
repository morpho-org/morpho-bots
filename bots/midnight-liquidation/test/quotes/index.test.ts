import { describe, expect, it } from 'bun:test'
import { getAddress, zeroAddress } from 'viem'

import type { SwapConfigEntry } from '../../src/config'
import type { Logger } from '../../src/logger'
import type { RateLimitedClient } from '../../src/quotes/http-client'
import type { LiquidationPlan } from '../../src/sizing/plan'
import type { LensOut } from '../../src/state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { composeQuoting } from '../../src/quotes'
import { QuoteError } from '../../src/quotes/types'

const NOOP_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const ROUTER = getAddress('0x5555555555555555555555555555555555555555')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const ORACLE = getAddress('0x8888888888888888888888888888888888888888')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')

const PLAN: LiquidationPlan = {
  collateralIndex: 0,
  seizedAssets: 1000n,
  repaidUnits: 0n,
  postMaturityMode: false
}

// price = 1 → expectedLoanOut(PLAN) = 1000 (the route-quality reference).
const OUT: LensOut = {
  valid: true,
  hasDebt: true,
  healthy: false,
  locked: false,
  gateAllows: true,
  blockTimestamp: 1000n,
  debt: 2000n,
  maxDebt: 900n,
  badDebt: 0n,
  activatedBitmap: 1n,
  bestCollateralIdx: 0,
  bestCollateralAmt: 1000n,
  bestCollateralPrice: ORACLE_PRICE_SCALE,
  bestCollateralMaxLif: (WAD * 11n) / 10n,
  bestCollateralLltv: (WAD * 86n) / 100n,
  market: {
    chainId: 8453n,
    midnight: zeroAddress,
    loanToken: LOAN,
    collateralParams: [
      {
        token: COLLATERAL,
        lltv: (WAD * 86n) / 100n,
        liquidationCursor: (WAD * 25n) / 100n,
        oracle: ORACLE
      }
    ],
    maturity: 2000n,
    rcfThreshold: WAD,
    enterGate: zeroAddress,
    liquidatorGate: zeroAddress
  }
}

function httpStub(body: unknown): RateLimitedClient {
  return { getJson: async <T>() => body as T }
}

const throwingHttp: RateLimitedClient = {
  getJson: async () => {
    throw new QuoteError('rate_limited', 'boom')
  }
}

function compose(entry: SwapConfigEntry | null, httpClient: RateLimitedClient) {
  const swapByCollateral = new Map<string, SwapConfigEntry>()
  if (entry) swapByCollateral.set(getAddress(COLLATERAL), entry)
  return composeQuoting({
    httpClient,
    chainId: 8453,
    executor: EXECUTOR,
    swapByCollateral,
    maxRouteImpactBps: 500, // floor = 1000 × 0.95 = 950
    logger: NOOP_LOGGER
  })
}

describe('composeQuoting', () => {
  it('returns no_config when the collateral has no configured venue', async () => {
    const { quoteFor } = compose(null, httpStub({}))
    expect(await quoteFor(PLAN, OUT)).toEqual({ kind: 'no_config' })
  })

  it('returns a uniswap swap (local, no API) when configured', async () => {
    const { quoteFor } = compose(
      { venue: 'uniswap-v3', router: ROUTER, fee: 3000, slippageBps: 50 },
      httpStub({})
    )
    const outcome = await quoteFor(PLAN, OUT)
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') expect(outcome.swap.spender).toBe(ROUTER)
  })

  it('rejects an aggregator route worse than maxRouteImpactBps below the oracle reference', async () => {
    // buyAmount 900 < floor 950 → bad route.
    const { quoteFor } = compose(
      { venue: '0x', slippageBps: 50 },
      httpStub({
        liquidityAvailable: true,
        buyAmount: '900',
        minBuyAmount: '895',
        transaction: { to: ROUTER, data: '0xabc' }
      })
    )
    expect(await quoteFor(PLAN, OUT)).toEqual({ kind: 'failed', reason: 'bad_route' })
  })

  it('accepts an aggregator route at or above the floor', async () => {
    const { quoteFor } = compose(
      { venue: '0x', slippageBps: 50 },
      httpStub({
        liquidityAvailable: true,
        buyAmount: '990',
        minBuyAmount: '985',
        transaction: { to: ROUTER, data: '0xabc' }
      })
    )
    expect((await quoteFor(PLAN, OUT)).kind).toBe('swap')
  })

  it('maps an adapter QuoteError to a failed outcome with its reason', async () => {
    const { quoteFor } = compose({ venue: '0x', slippageBps: 50 }, throwingHttp)
    expect(await quoteFor(PLAN, OUT)).toEqual({ kind: 'failed', reason: 'rate_limited' })
  })
})
