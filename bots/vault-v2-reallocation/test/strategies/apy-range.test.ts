import type { Hex } from 'viem'

import { parseUnits } from 'viem'
import { beforeEach, describe, expect, it } from 'vitest'

import type { ApyRangeConfig } from '../../src/strategies/apy-range'

import { apyToRate, percentToWad, rateToUtilization } from '../../src/math'
import { createApyRangeStrategy } from '../../src/strategies/apy-range'
import { makeMarket, makeVaultData, RATE_AT_TARGET, resetMarketCounter } from './helpers'

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
    capBufferPercent: 99.99,
    apyRange: (_vault, marketId) => {
      const range = overrides.marketApyRanges?.[marketId] ?? defaultApyRange
      return { min: percentToWad(range.min), max: percentToWad(range.max) }
    },
    // No min delta threshold by default so tests are predictable.
    minApyDeltaBips: () => overrides.minApyDeltaBips ?? 0
  }
  return createApyRangeStrategy(config)
}

/** The utilization at which the market yields the given borrow APY. */
const apyToUtilization = (apyPercent: number, rateAtTarget: bigint): bigint =>
  rateToUtilization(apyToRate(percentToWad(apyPercent)), rateAtTarget)

describe('createApyRangeStrategy', () => {
  beforeEach(() => {
    resetMarketCounter()
  })

  describe('no reallocation needed', () => {
    it('returns undefined when all markets are within APY range', () => {
      const strategy = makeStrategy()
      const market = makeMarket({
        utilization: apyToUtilization(5, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      expect(strategy(makeVaultData([market]))).toBeUndefined()
    })

    it('returns undefined when only one market is out of range with no counterpart or idle', () => {
      const strategy = makeStrategy()
      const market = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      expect(strategy(makeVaultData([market]))).toBeUndefined()
    })
  })

  describe('basic reallocation', () => {
    it('deallocates from below-range and allocates to above-range markets (deltas)', () => {
      const strategy = makeStrategy()
      const hotMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const coldMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        rateAtTarget: RATE_AT_TARGET
      })

      const result = strategy(makeVaultData([hotMarket, coldMarket]))

      expect(result).toBeDefined()
      expect(result!.allocations.length).toBe(1)
      expect(result!.deallocations.length).toBe(1)
      const allocation = result!.allocations[0]!
      const deallocation = result!.deallocations[0]!
      expect(allocation.marketParams).toEqual(hotMarket.params)
      expect(deallocation.marketParams).toEqual(coldMarket.params)
      expect(allocation.assets).toBeGreaterThan(0n)
      expect(deallocation.assets).toBeGreaterThan(0n)
      expect(deallocation.assets).toBeLessThanOrEqual(coldMarket.vaultAssets)
    })

    it('does not include in-range markets', () => {
      const strategy = makeStrategy()
      const inRangeMarket = makeMarket({
        utilization: apyToUtilization(5, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const hotMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const coldMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        rateAtTarget: RATE_AT_TARGET
      })

      const result = strategy(makeVaultData([inRangeMarket, hotMarket, coldMarket]))

      expect(result).toBeDefined()
      const legs = [...result!.allocations, ...result!.deallocations].map(l => l.marketParams)
      expect(legs).not.toContainEqual(inRangeMarket.params)
    })

    it('honors a per-market APY range override', () => {
      const overridden = makeMarket({
        utilization: apyToUtilization(5, RATE_AT_TARGET), // in default 2-8%, above overridden 2-4%
        vaultAssets: parseUnits('10000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const coldMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const strategy = makeStrategy({ marketApyRanges: { [overridden.id]: { min: 2, max: 4 } } })

      const result = strategy(makeVaultData([overridden, coldMarket]))

      expect(result).toBeDefined()
      expect(result!.allocations.map(l => l.marketParams)).toContainEqual(overridden.params)
    })
  })

  describe('min APY delta threshold', () => {
    it('returns undefined when APY delta is below threshold', () => {
      const strategy = makeStrategy({ minApyDeltaBips: 10_000 }) // 100%
      const hotMarket = makeMarket({
        utilization: apyToUtilization(9, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const coldMarket = makeMarket({
        utilization: apyToUtilization(1.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      expect(strategy(makeVaultData([hotMarket, coldMarket]))).toBeUndefined()
    })
  })

  describe('idle handling', () => {
    it('funds surplus allocations from the idle balance', () => {
      const strategy = makeStrategy()
      const hotMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const result = strategy(makeVaultData([hotMarket], { idleAssets: parseUnits('50000', 6) }))
      // Only an allocation candidate: with no deallocation source the whole leg is idle-funded...
      // but min(dealloc, alloc) === 0 with dealloc 0 — matching the old bot, idle-only funding
      // still requires at least one deallocation leg. Verify surplus-topping instead:
      expect(result).toBeUndefined()

      const coldMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('100', 6), // tiny deallocation source
        rateAtTarget: RATE_AT_TARGET
      })
      const topped = strategy(
        makeVaultData([hotMarket, coldMarket], { idleAssets: parseUnits('50000', 6) })
      )
      expect(topped).toBeDefined()
      const totalAllocated = topped!.allocations.reduce((acc, l) => acc + l.assets, 0n)
      const totalDeallocated = topped!.deallocations.reduce((acc, l) => acc + l.assets, 0n)
      expect(totalAllocated).toBeGreaterThan(totalDeallocated)
    })

    it('clamps deallocations to allocations when idle reallocation is disabled', () => {
      const strategy = makeStrategy({ allowIdleReallocation: false })
      const coldMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      // Only a deallocation candidate: with idle parking disabled the totals clamp to zero.
      expect(strategy(makeVaultData([coldMarket]))).toBeUndefined()
    })
  })

  describe('cap enforcement', () => {
    it('clamps allocations to the market cap headroom measured against allocation(id)', () => {
      const strategy = makeStrategy()
      const vaultAssets = parseUnits('10000', 6)
      const hotMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets,
        cap: {
          absolute: vaultAssets + parseUnits('100', 6),
          relative: 10n ** 18n,
          allocation: vaultAssets
        },
        rateAtTarget: RATE_AT_TARGET
      })
      const coldMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        rateAtTarget: RATE_AT_TARGET
      })

      const result = strategy(makeVaultData([hotMarket, coldMarket]))

      expect(result).toBeDefined()
      expect(result!.allocations[0]!.assets).toBeLessThanOrEqual(parseUnits('100', 6))
    })

    it('returns undefined when the cap is already reached (no allocation headroom)', () => {
      const strategy = makeStrategy()
      const vaultAssets = parseUnits('10000', 6)
      const cappedMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets,
        cap: { absolute: vaultAssets, relative: 10n ** 18n, allocation: vaultAssets },
        rateAtTarget: RATE_AT_TARGET
      })
      const coldMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      expect(strategy(makeVaultData([cappedMarket, coldMarket]))).toBeUndefined()
    })

    it('clamps total allocations to the adapter-level cap pool', () => {
      const strategy = makeStrategy()
      const hotMarket = makeMarket({
        utilization: apyToUtilization(12, RATE_AT_TARGET),
        vaultAssets: parseUnits('10000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const coldMarket = makeMarket({
        utilization: apyToUtilization(0.5, RATE_AT_TARGET),
        vaultAssets: parseUnits('20000', 6),
        rateAtTarget: RATE_AT_TARGET
      })
      const adapterAllocation = parseUnits('30000', 6)
      const result = strategy(
        makeVaultData([hotMarket, coldMarket], {
          idleAssets: parseUnits('1000', 6), // raises totalAssets so the 100% relative cap has headroom
          adapterCap: {
            absolute: adapterAllocation + parseUnits('50', 6),
            relative: 10n ** 18n,
            allocation: adapterAllocation
          }
        })
      )
      expect(result).toBeDefined()
      const totalAllocated = result!.allocations.reduce((acc, l) => acc + l.assets, 0n)
      expect(totalAllocated).toBeLessThanOrEqual(parseUnits('50', 6))
      expect(totalAllocated).toBeGreaterThan(0n)
    })
  })
})
