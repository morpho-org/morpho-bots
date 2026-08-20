import type { Hex } from 'viem'

import { wholePercentToWAD } from '@repo/utils'
import { maxUint256, parseUnits, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { ApyRangeConfig } from '../../src/strategies/apy-range'

import { apyToRate, rateToUtilization } from '../../src/math'
import { createApyRangeStrategy } from '../../src/strategies/apy-range'
import { makeIdleMarket, makeMarket, makeVaultData, RATE_AT_TARGET } from './helpers'

type ApyRangePercent = { min: number; max: number }

const makeStrategy = (
  overrides: Partial<{
    allowIdleReallocation: boolean
    defaultApyRange: ApyRangePercent
    minApyDeltaBips: number
    marketApyRanges: Record<Hex, ApyRangePercent>
  }> = {}
) => {
  const defaultApyRange = overrides.defaultApyRange ?? { min: 2, max: 8 }
  const config: ApyRangeConfig = {
    allowIdleReallocation: overrides.allowIdleReallocation ?? true,
    capBufferWad: wholePercentToWAD(99.99),
    apyRange: (_vault, marketId) => {
      const range = overrides.marketApyRanges?.[marketId] ?? defaultApyRange
      return { min: wholePercentToWAD(range.min), max: wholePercentToWAD(range.max) }
    },
    // No min delta threshold by default so tests are predictable.
    minApyDeltaBips: () => overrides.minApyDeltaBips ?? 0
  }
  return createApyRangeStrategy(config)
}

/** The utilization at which the market yields the given borrow APY. */
const apyToUtilization = (apyPercent: number, rateAtTarget: bigint): bigint =>
  rateToUtilization(apyToRate(wholePercentToWAD(apyPercent)), rateAtTarget)

describe('createApyRangeStrategy', () => {
  describe('no reallocation needed', () => {
    it('returns undefined when all markets are within APY range', () => {
      const strategy = makeStrategy()
      const market = makeMarket({
        utilization: apyToUtilization(5, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      expect(strategy(makeVaultData([market]))).toBeUndefined()
    })

    it('returns undefined when only one market is out of range with no counterpart', () => {
      const strategy = makeStrategy()
      const market = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      expect(strategy(makeVaultData([market]))).toBeUndefined()
    })

    it('returns undefined when all markets are below lower bound (no deposit targets)', () => {
      const strategy = makeStrategy()
      const lowUtilization = apyToUtilization(0.5, RATE_AT_TARGET)
      const market1 = makeMarket({
        utilization: lowUtilization,
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const market2 = makeMarket({
        utilization: lowUtilization,
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      expect(strategy(makeVaultData([market1, market2]))).toBeUndefined()
    })
  })

  describe('zero-delta market handling', () => {
    it('excludes deposit market when supply cap is already reached', () => {
      const strategy = makeStrategy()
      const vaultAssets = parseUnits('50000', 6)
      const capReachedMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets,
        cap: vaultAssets, // no room to deposit
        rateAtTarget: RATE_AT_TARGET
      })
      const withdrawalMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      expect(strategy(makeVaultData([capReachedMarket, withdrawalMarket]))).toBeUndefined()
    })

    it('excludes withdrawal market when vault has no assets in that market', () => {
      const strategy = makeStrategy()
      const emptyMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: 0n, // nothing to withdraw
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const depositMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      expect(strategy(makeVaultData([emptyMarket, depositMarket]))).toBeUndefined()
    })

    it('skips cap-reached market but includes other deposit markets', () => {
      const strategy = makeStrategy()
      const highUtilization = apyToUtilization(12, RATE_AT_TARGET)
      const vaultAssets1 = parseUnits('50000', 6)
      const capReachedMarket = makeMarket({
        utilization: highUtilization,
        vaultAssets: vaultAssets1,
        cap: vaultAssets1,
        rateAtTarget: RATE_AT_TARGET
      })
      const depositMarket = makeMarket({
        utilization: highUtilization,
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const withdrawalMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })

      const result = strategy(makeVaultData([capReachedMarket, depositMarket, withdrawalMarket]))

      expect(result).toBeDefined()
      const marketParams = result!.map(r => r.marketParams)
      expect(marketParams).not.toContainEqual(capReachedMarket.params)
      expect(marketParams).toContainEqual(depositMarket.params)
      expect(marketParams).toContainEqual(withdrawalMarket.params)
    })
  })

  describe('basic reallocation', () => {
    it('withdraws from below-range and deposits to above-range market', () => {
      const strategy = makeStrategy()
      const depositMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const withdrawalMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })

      const result = strategy(makeVaultData([depositMarket, withdrawalMarket]))

      expect(result).toBeDefined()
      expect(result!.length).toBe(2)
      const withdrawal = result![0]!
      const deposit = result![1]!
      expect(withdrawal.marketParams).toEqual(withdrawalMarket.params)
      expect(deposit.marketParams).toEqual(depositMarket.params)
      expect(withdrawal.assets).toBeLessThan(withdrawalMarket.vaultAssets)
      expect(deposit.assets === maxUint256 || deposit.assets > depositMarket.vaultAssets).toBe(true)
    })

    it('does not include in-range markets in the reallocation', () => {
      const strategy = makeStrategy()
      const inRangeMarket = makeMarket({
        utilization: apyToUtilization(5, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const depositMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const withdrawalMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })

      const result = strategy(makeVaultData([inRangeMarket, depositMarket, withdrawalMarket]))

      expect(result).toBeDefined()
      expect(result!.map(r => r.marketParams)).not.toContainEqual(inRangeMarket.params)
    })

    it('honors a per-market APY range override', () => {
      const utilizationAt5 = apyToUtilization(5, RATE_AT_TARGET)
      const overriddenMarket = makeMarket({
        utilization: utilizationAt5, // in the default 2-8% range, above an overridden 2-4% range
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const withdrawalMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const strategy = makeStrategy({
        marketApyRanges: { [overriddenMarket.id]: { min: 2, max: 4 } }
      })

      const result = strategy(makeVaultData([overriddenMarket, withdrawalMarket]))

      expect(result).toBeDefined()
      expect(result!.map(r => r.marketParams)).toContainEqual(overriddenMarket.params)
    })
  })

  describe('min APY delta threshold', () => {
    it('returns undefined when APY delta is below threshold', () => {
      const strategy = makeStrategy({ minApyDeltaBips: 10_000 }) // 100%
      const depositMarket = makeMarket({
        utilization: apyToUtilization(9, RATE_AT_TARGET), // slightly above 8% max
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const withdrawalMarket = makeMarket({
        utilization: apyToUtilization(1.5, RATE_AT_TARGET), // slightly below 2% min
        vaultAssets: parseUnits('20000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      expect(strategy(makeVaultData([depositMarket, withdrawalMarket]))).toBeUndefined()
    })
  })

  describe('idle market handling', () => {
    it('uses idle market as deposit target for excess withdrawals', () => {
      const strategy = makeStrategy()
      const withdrawalMarket = makeMarket({
        // Borrowed, unlike this file's other cold markets: the idle leg carries no min-delta
        // verdict, so the realized APY move on THIS leg is the only thing that can arm the plan.
        utilization: apyToUtilization(1.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const idleMarket = makeIdleMarket(0n)

      const result = strategy(makeVaultData([withdrawalMarket, idleMarket]))

      expect(result).toBeDefined()
      const idleAlloc = result!.find(r => r.marketParams.collateralToken === zeroAddress)
      expect(idleAlloc).toBeDefined()
      expect(idleAlloc!.assets).toBe(maxUint256)
    })

    it('uses idle market as withdrawal source for deposits', () => {
      const strategy = makeStrategy()
      const depositMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const idleMarket = makeIdleMarket(parseUnits('50000', 6))

      const result = strategy(makeVaultData([depositMarket, idleMarket]))

      expect(result).toBeDefined()
      const idleAlloc = result!.find(r => r.marketParams.collateralToken === zeroAddress)
      expect(idleAlloc).toBeDefined()
      expect(idleAlloc!.assets).toBeLessThan(parseUnits('50000', 6))
    })

    it('does not use idle market when idle reallocation is disabled', () => {
      const strategy = makeStrategy({ allowIdleReallocation: false })
      const withdrawalMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const idleMarket = makeIdleMarket(0n)
      expect(strategy(makeVaultData([withdrawalMarket, idleMarket]))).toBeUndefined()
    })
  })

  describe('non-AdaptiveCurve markets', () => {
    // With rateAtTarget = 0 the curve inverse returns WAD for every rate, so both bounds collapse to
    // WAD and the market reads as "far below range" — the strategy would withdraw the vault's entire
    // position out of it on perfectly valid, simulation-passing calldata.
    const foreignIrmMarket = () =>
      makeMarket({
        utilization: (50n * 10n ** 18n) / 100n,
        vaultAssets: parseUnits('20000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: 0n,
        isAdaptiveCurve: false
      })

    it('never withdraws from a market that is not on the AdaptiveCurveIRM', () => {
      const strategy = makeStrategy()
      const foreign = foreignIrmMarket()
      const depositMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const withdrawalMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })

      const result = strategy(makeVaultData([foreign, depositMarket, withdrawalMarket]))

      expect(result).toBeDefined()
      expect(result!.map(r => r.marketParams)).not.toContainEqual(foreign.params)
    })

    it('does not let a non-AdaptiveCurve market trip the min-delta gate on its own', () => {
      const strategy = makeStrategy()
      const foreign = foreignIrmMarket()
      const depositMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      // Only counterpart is the foreign-IRM market: with it excluded there is nothing to withdraw.
      expect(strategy(makeVaultData([foreign, depositMarket]))).toBeUndefined()
    })
  })

  describe('idle market cap headroom', () => {
    it('does not build a plan from negative idle headroom when the cap is below the allocation', () => {
      const strategy = makeStrategy()
      const withdrawalMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      // A curator lowered the idle cap under the current allocation: `cap - vaultAssets` is negative.
      const idleMarket = makeIdleMarket(parseUnits('50000', 6), parseUnits('10000', 6))

      // The idle market is the only deposit target, and it has no headroom — so no plan at all,
      // rather than a corrupt one-leg plan sized off a negative amount.
      expect(strategy(makeVaultData([withdrawalMarket, idleMarket]))).toBeUndefined()
    })

    it('buffers the idle cap like every other deposit target', () => {
      const strategy = makeStrategy()
      const withdrawalMarket = makeMarket({
        // Borrowed, unlike this file's other cold markets: the idle leg carries no min-delta
        // verdict, so the realized APY move on THIS leg is the only thing that can arm the plan.
        utilization: apyToUtilization(1.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const idleMarket = makeIdleMarket(0n, parseUnits('1000', 6))

      const result = strategy(makeVaultData([withdrawalMarket, idleMarket]))

      expect(result).toBeDefined()
      const withdrawal = result!.find(r => r.marketParams === withdrawalMarket.params)!
      // Bounded by 99.99% of the 1k idle cap, not the full 1k.
      const moved = withdrawalMarket.vaultAssets - withdrawal.assets
      expect(moved).toBeLessThan(parseUnits('1000', 6))
      expect(moved).toBeGreaterThan(parseUnits('999', 6))
    })
  })

  // Any requested APY ≥ 4·rateAtTarget inverts to a utilization bound of exactly WAD, so a wide
  // range on a cold market legitimately produces bounds no market can ever sit inside. The clamp then
  // sizes the move against 99.9% — but must never flip which side of the trade the market is on.
  describe('degenerate (≥WAD) bounds under the target clamp', () => {
    // min 20% APY is past 4·RATE_AT_TARGET (~12% APY), so BOTH bounds invert to WAD.
    const DEGENERATE_RANGE = { min: 20, max: 25 }

    const degenerateMarket = (utilization: bigint, vaultAssets: bigint) =>
      makeMarket({
        utilization,
        vaultAssets,
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })

    it('emits no leg for a market the clamp leaves at or past its target', () => {
      // u = 99.95% is BELOW the raw WAD lower bound (so the intent is a withdrawal) but ABOVE the
      // clamped 99.9% target. Re-deriving the side from the clamped target would read "above target"
      // and emit a DEPOSIT — the exact inversion this rule removes.
      const degenerate = degenerateMarket(wholePercentToWAD(99.95), parseUnits('20000', 6))
      const siblingWithdraw = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const siblingDeposit = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const strategy = makeStrategy({
        marketApyRanges: { [degenerate.id]: DEGENERATE_RANGE }
      })

      const result = strategy(makeVaultData([degenerate, siblingWithdraw, siblingDeposit]))

      // The degenerate market drops out, and it does so WITHOUT taking the rest of the pass with it.
      expect(result).toBeDefined()
      expect(result!.map(leg => leg.marketParams)).not.toContainEqual(degenerate.params)
      expect(result!.map(leg => leg.marketParams)).toContainEqual(siblingWithdraw.params)
      expect(result!.map(leg => leg.marketParams)).toContainEqual(siblingDeposit.params)
    })

    it('still exits a dead cold market, sized against the clamped target', () => {
      // Same degenerate bounds, but far below the clamp: the exit intent survives. This is the
      // anti-skip assertion — the rule drops empty/backwards moves, never whole markets.
      const degenerate = degenerateMarket(wholePercentToWAD(50), parseUnits('100000', 6))
      const idle = makeIdleMarket(0n)
      const strategy = makeStrategy({
        marketApyRanges: { [degenerate.id]: DEGENERATE_RANGE }
      })

      const result = strategy(makeVaultData([degenerate, idle]))

      expect(result).toBeDefined()
      const withdrawal = result!.find(leg => leg.marketParams === degenerate.params)!
      // 100k · (1 − 0.5/0.999) ≈ 49,949.949949 — strictly less than the full S − B = 50k the raw
      // WAD bound would have asked for.
      expect(withdrawal.assets).toBe(parseUnits('100000', 6) - 49_949_949_949n)
    })

    it('arms the min-delta gate off the clamped bound, not the raw one', () => {
      // At u = 99.89% the APY move to the raw WAD bound is ~11.15 bips, but only ~1.01 bips to the
      // clamped 99.9% target. A 5-bip threshold must therefore NOT fire: the plan can only realize
      // the clamped move. The idle market is the sole counterpart precisely because idle legs carry
      // no verdict, so the gate hinges on this market alone.
      const degenerate = degenerateMarket(wholePercentToWAD(99.89), parseUnits('20000', 6))
      const ranges = { [degenerate.id]: DEGENERATE_RANGE }
      const plan = (minApyDeltaBips: number) =>
        makeStrategy({ marketApyRanges: ranges, minApyDeltaBips })(
          makeVaultData([degenerate, makeIdleMarket(0n)])
        )

      expect(plan(5)).toBeUndefined()
      // Funded control: a threshold under the clamped delta still fires, so the case above is a
      // threshold verdict and not a market that silently stopped producing a leg.
      expect(plan(1)).toBeDefined()
    })
  })

  describe('last deposit gets maxUint256', () => {
    it('assigns maxUint256 to the last deposit market', () => {
      const strategy = makeStrategy()
      const depositMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const withdrawalMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        cap: parseUnits('100000', 6),
        rateAtTarget: RATE_AT_TARGET
      })

      const result = strategy(makeVaultData([depositMarket, withdrawalMarket]))

      expect(result).toBeDefined()
      const deposits = result!.filter(r => r.marketParams === depositMarket.params)
      expect(deposits.length).toBe(1)
      expect(deposits[0]!.assets).toBe(maxUint256)
    })
  })
})
