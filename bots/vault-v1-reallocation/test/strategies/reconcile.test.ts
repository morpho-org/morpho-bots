import { wholePercentToWAD } from '@repo/utils'
import { maxUint256, parseUnits, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { Classify, MoveIntent, ReconcilerOptions } from '../../src/strategies/reconcile'
import type { VaultMarketData } from '../../src/vault-data'

import { getUtilization, wadToBips } from '../../src/math'
import { createReconciler } from '../../src/strategies/reconcile'
import { makeIdleMarket, makeMarket, makeVaultData, RATE_AT_TARGET } from './helpers'

const WAD = 10n ** 18n
const CAP_BUFFER_WAD = wholePercentToWAD(99.99)

// The classifier's own job, reproduced for these stubs: the side is read off the RAW target, so the
// reconciler's own clamp never flips it.
const intentFor = (marketData: VaultMarketData, rawTarget: bigint): MoveIntent =>
  getUtilization(marketData.state) > rawTarget ? 'deposit' : 'withdraw'

/** Every non-idle market targets `targetUtilization`, and every move clears the threshold. */
const fixedTarget =
  (targetUtilization: bigint): Classify =>
  marketData => ({
    targetUtilization,
    intent: intentFor(marketData, targetUtilization),
    clearsMinDelta: () => true
  })

const makeReconciler = (
  options: Omit<ReconcilerOptions, 'capBufferWad' | 'classifierFor'>,
  classify: Classify
) => createReconciler({ ...options, capBufferWad: CAP_BUFFER_WAD, classifierFor: () => classify })

const market = (utilization: bigint, vaultAssets: bigint, cap = parseUnits('100000', 6)) =>
  makeMarket({ utilization, vaultAssets, cap, rateAtTarget: RATE_AT_TARGET })

describe('createReconciler', () => {
  describe("idle: 'net'", () => {
    it('parks the excess withdrawal in the idle market', () => {
      const reconcile = makeReconciler(
        { idle: 'net', allowIdleReallocation: true },
        fixedTarget((80n * WAD) / 100n)
      )
      const cold = market((10n * WAD) / 100n, parseUnits('20000', 6))
      const idle = makeIdleMarket(0n)

      const result = reconcile(makeVaultData([cold, idle]))

      expect(result).toBeDefined()
      expect(result!.length).toBe(2)
      expect(result![0]!.marketParams).toEqual(cold.params)
      expect(result![0]!.assets).toBeLessThan(cold.vaultAssets)
      expect(result![1]!.marketParams.collateralToken).toBe(zeroAddress)
      expect(result![1]!.assets).toBe(maxUint256)
    })

    it('draws the missing deposit liquidity out of the idle market', () => {
      const reconcile = makeReconciler(
        { idle: 'net', allowIdleReallocation: true },
        fixedTarget((50n * WAD) / 100n)
      )
      const hot = market((90n * WAD) / 100n, 0n)
      const idle = makeIdleMarket(parseUnits('50000', 6))

      const result = reconcile(makeVaultData([hot, idle]))

      expect(result).toBeDefined()
      const idleLeg = result!.find(leg => leg.marketParams.collateralToken === zeroAddress)!
      expect(idleLeg.assets).toBeLessThan(idle.vaultAssets)
      expect(result!.indexOf(idleLeg)).toBe(0) // withdrawals first
    })

    it('leaves the idle market alone when idle reallocation is disabled', () => {
      const reconcile = makeReconciler(
        { idle: 'net', allowIdleReallocation: false },
        fixedTarget((80n * WAD) / 100n)
      )
      const cold = market((10n * WAD) / 100n, parseUnits('20000', 6))
      expect(reconcile(makeVaultData([cold, makeIdleMarket(0n)]))).toBeUndefined()
    })
  })

  describe("idle: 'ignore'", () => {
    it('never emits an idle leg, and sizes the plan to the smaller side', () => {
      const reconcile = makeReconciler({ idle: 'ignore' }, fixedTarget((50n * WAD) / 100n))
      const hot = market((90n * WAD) / 100n, 0n)
      const cold = market((10n * WAD) / 100n, parseUnits('5000', 6))
      const idle = makeIdleMarket(parseUnits('50000', 6))

      const result = reconcile(makeVaultData([hot, cold, idle]))

      expect(result).toBeDefined()
      expect(result!.map(leg => leg.marketParams.collateralToken)).not.toContain(zeroAddress)
      // The cold market's 5k position is the whole budget, so it is fully withdrawn.
      expect(result![0]!.marketParams).toEqual(cold.params)
      expect(result![0]!.assets).toBe(0n)
      expect(result![1]!.assets).toBe(maxUint256)
    })

    it('returns undefined when one side has no counterpart', () => {
      const reconcile = makeReconciler({ idle: 'ignore' }, fixedTarget((50n * WAD) / 100n))
      const cold = market((10n * WAD) / 100n, parseUnits('20000', 6))
      expect(
        reconcile(makeVaultData([cold, makeIdleMarket(parseUnits('50000', 6))]))
      ).toBeUndefined()
    })
  })

  describe('budget trimming', () => {
    it('fills deposits in withdraw-queue order and drops the markets past the budget', () => {
      const reconcile = makeReconciler({ idle: 'ignore' }, fixedTarget((50n * WAD) / 100n))
      // Each hot market could absorb 40k (100k supply * (0.7/0.5 - 1)), but the single cold market
      // only frees 50k — so hot1 takes 40k, hot2 takes the last 10k, and hot3 gets no leg at all.
      const hot1 = market((70n * WAD) / 100n, 0n)
      const hot2 = market((70n * WAD) / 100n, 0n)
      const hot3 = market((70n * WAD) / 100n, 0n)
      const cold = market((25n * WAD) / 100n, parseUnits('50000', 6))

      const result = reconcile(makeVaultData([hot1, hot2, hot3, cold]))

      expect(result).toBeDefined()
      // Withdrawals come first, then the deposits in queue order; hot3 contributes no leg.
      expect(result!.map(leg => leg.marketParams)).toEqual([cold, hot1, hot2].map(m => m.params))
      expect(result![0]!.assets).toBe(0n)
      expect(result![1]!.assets).toBe(parseUnits('40000', 6))
      expect(result![2]!.assets).toBe(maxUint256)
    })

    it('gates on the min-delta flag of a market that actually contributes', () => {
      const targetUtilization = (50n * WAD) / 100n
      const cold = market((10n * WAD) / 100n, parseUnits('20000', 6))
      const hot = market((90n * WAD) / 100n, 0n)
      // Capped out at its current position: it can absorb nothing, so its flag must not arm the gate.
      const cappedHot = market((90n * WAD) / 100n, parseUnits('10000', 6), parseUnits('10000', 6))
      const reconcileWith = (clearingMarketIds: string[]) =>
        makeReconciler({ idle: 'ignore' }, marketData => ({
          targetUtilization,
          intent: intentFor(marketData, targetUtilization),
          clearsMinDelta: () => clearingMarketIds.includes(marketData.id)
        }))(makeVaultData([cold, hot, cappedHot]))

      expect(reconcileWith([cappedHot.id])).toBeUndefined()
      // Same shape with a contributing market clearing the threshold fires.
      expect(reconcileWith([hot.id])).toBeDefined()
    })

    it('does not arm the gate from a clearing market the budget trims out entirely', () => {
      const targetUtilization = (50n * WAD) / 100n
      // hot1 alone can absorb 80k, so it consumes the whole budget in queue order and hot2 — the
      // only market clearing the threshold — gets no leg at all.
      const hot1 = market((90n * WAD) / 100n, 0n)
      const hot2 = market((90n * WAD) / 100n, 0n)
      const cold = market((25n * WAD) / 100n, parseUnits('50000', 6))
      const cold2 = market((25n * WAD) / 100n, parseUnits('50000', 6))
      const reconcileWith = (markets: (typeof cold)[]) =>
        makeReconciler({ idle: 'ignore' }, marketData => ({
          targetUtilization,
          intent: intentFor(marketData, targetUtilization),
          clearsMinDelta: () => marketData.id === hot2.id
        }))(makeVaultData(markets))

      expect(reconcileWith([hot1, hot2, cold])).toBeUndefined()
      // Twice the budget reaches hot2, so its cleared threshold arms the plan.
      const funded = reconcileWith([hot1, hot2, cold, cold2])
      expect(funded).toBeDefined()
      expect(funded!.map(leg => leg.marketParams)).toContainEqual(hot2.params)
    })
  })

  describe('realized-delta gate', () => {
    const targetUtilization = (50n * WAD) / 100n
    // A real classifier's shape: the verdict is a function of the utilization the leg actually
    // reaches, so a leg the budget trims can no longer arm the plan with its full-size promise.
    const utilizationDelta =
      (minBips: number): Classify =>
      marketData => {
        const utilization = getUtilization(marketData.state)
        return {
          targetUtilization,
          intent: intentFor(marketData, targetUtilization),
          clearsMinDelta: utilizationAfter =>
            Math.abs(wadToBips(utilization - utilizationAfter)) > minBips
        }
      }

    // 90% → 50% would be a 4000-bip move; the budget below leaves 1 wei of it.
    const clearingHot = () => market((90n * WAD) / 100n, 0n)

    it('does not arm the plan from a clearing move trimmed to a dust fragment', () => {
      const reconcile = makeReconciler({ idle: 'ignore' }, utilizationDelta(100))
      // The only withdrawable counterpart holds 1 wei, so the whole plan is 1 wei wide.
      const dustCold = market((25n * WAD) / 100n, 1n)

      expect(reconcile(makeVaultData([clearingHot(), dustCold]))).toBeUndefined()
    })

    it('fires on the same shape once the counterpart is actually funded', () => {
      const reconcile = makeReconciler({ idle: 'ignore' }, utilizationDelta(100))
      const cold = market((25n * WAD) / 100n, parseUnits('20000', 6))

      const result = reconcile(makeVaultData([clearingHot(), cold]))

      expect(result).toBeDefined()
      expect(result!.map(leg => leg.assets)).toEqual([0n, maxUint256])
    })

    it('gates a partial trim on the delta that trim realizes, not the full-size one', () => {
      // A 5k budget moves the hot market 90% → 85.71%, a realized 428 bips of the 4000 the full-size
      // deposit advertised: it clears a 400-bip threshold and misses a 500-bip one.
      const partial = (minBips: number) =>
        makeReconciler(
          { idle: 'ignore' },
          utilizationDelta(minBips)
        )(makeVaultData([clearingHot(), market((25n * WAD) / 100n, parseUnits('5000', 6))]))

      expect(partial(400)).toBeDefined()
      expect(partial(500)).toBeUndefined()
    })
  })

  describe('target clamp', () => {
    it("clamps a WAD target so no leg drains a market's full free liquidity", () => {
      // A cold market whose AdaptiveCurve bound degenerates to WAD (rate >= 4·rateAtTarget) must not
      // be sized to withdraw S − B exactly — that reverts on the first wei of accrual. The reconciler
      // clamps the target at 99.9%, leaving a realizable sliver behind.
      const reconcile = makeReconciler(
        { idle: 'net', allowIdleReallocation: true },
        fixedTarget(WAD)
      )
      const cold = market((50n * WAD) / 100n, parseUnits('100000', 6))
      const idle = makeIdleMarket(0n)

      const result = reconcile(makeVaultData([cold, idle]))

      expect(result).toBeDefined()
      const withdrawal = result!.find(leg => leg.marketParams === cold.params)!
      // 100k · (1 − 0.5/0.999) ≈ 49,949.949949 withdrawn — strictly less than the full S − B = 50k.
      expect(withdrawal.assets).toBe(parseUnits('100000', 6) - 49_949_949_949n)
    })
  })
})
