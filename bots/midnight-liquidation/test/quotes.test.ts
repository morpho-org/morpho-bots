import type { Logger } from '@repo/bot-kit'
import type { RateLimitedClient, SwapConfigEntry } from '@repo/swaps'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { Market } from '../src/execution/encode-call'
import type { LiquidationPlan } from '../src/sizing/plan'
import type { LensOut } from '../src/state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../src/constants'
import { composeQuoting } from '../src/quotes'

// The Midnight-shaped adapter over @repo/swaps' composeQuoting: these cases pin the LENS PROJECTION
// (out.market.collateralParams[plan.collateralIndex] → QuoteRequest) and the missing-slot
// short-circuit; the venue/floor behavior itself is tested in the package.

const NOOP_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const ROUTER = getAddress('0x5555555555555555555555555555555555555555')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const ORACLE = getAddress('0x8888888888888888888888888888888888888888')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
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

// price = 1e36 → expectedLoanOut = seizedAssets = 1000 (the route-quality reference).
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

const NOOP_HTTP: RateLimitedClient = { getJson: async <T>() => ({}) as T }

function compose(entry: SwapConfigEntry | null) {
  const swapByCollateral = new Map<string, SwapConfigEntry>()
  if (entry) swapByCollateral.set(getAddress(COLLATERAL), entry)
  return composeQuoting({
    httpClient: NOOP_HTTP,
    chainId: 8453,
    executor: EXECUTOR,
    swapByCollateral,
    maxRouteImpactBps: 500,
    logger: NOOP_LOGGER
  })
}

describe('composeQuoting (Midnight lens-projection adapter)', () => {
  it('returns no_config when the plan indexes a missing collateral slot', async () => {
    const { quoteFor } = compose({ venue: 'uniswap-v3', router: ROUTER, fee: 3000, slippageBps: 0 })
    const outOfRange = { ...PLAN, collateralIndex: 5 }
    expect(await quoteFor(outOfRange, OUT)).toEqual({ kind: 'no_config' })
  })

  it('returns no_config when the indexed collateral has no configured venue', async () => {
    const { quoteFor } = compose(null)
    expect(await quoteFor(PLAN, OUT)).toEqual({ kind: 'no_config' })
  })

  it('projects the indexed collateral + oracle reference into an executable swap', async () => {
    const { quoteFor } = compose({ venue: 'uniswap-v3', router: ROUTER, fee: 3000, slippageBps: 0 })
    const outcome = await quoteFor(PLAN, OUT)
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') {
      expect(outcome.swap.spender).toBe(ROUTER)
      // slippageBps 0 → the min-out IS the oracle reference (seizedAssets at price 1e36) — proving
      // expectedLoanOut(plan, out) was passed as referenceAmountOut.
      expect(outcome.swap.amountOutMinimum).toBe(1000n)
    }
  })
})
