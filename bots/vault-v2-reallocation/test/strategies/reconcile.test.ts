import { wholePercentToWAD } from '@repo/utils'
import { parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import type { Classify, MarketTarget } from '../../src/strategies/reconcile'

import { getUtilization, wadToBips } from '../../src/math'
import { createReconciler } from '../../src/strategies/reconcile'
import { makeMarket, makeVaultData, RATE_AT_TARGET } from '../helpers'

const WAD = 10n ** 18n

const makeReconciler = (
  classify: Classify,
  overrides: Partial<{ allowIdleParking: boolean; capBufferWad: bigint }> = {}
) =>
  createReconciler({
    capBufferWad: overrides.capBufferWad ?? wholePercentToWAD(99.99),
    allowIdleParking: overrides.allowIdleParking ?? true,
    classifierFor: () => classify
  })

// Classifier contract in miniature: intent from the RAW target, target handed over pre-clamped
// (the reconciler's own clamp is only a backstop) — tests pass raw targets to exercise it.
const toTarget =
  (rawTarget: bigint, clearsMinDelta = true): Classify =>
  (marketData): MarketTarget => ({
    targetUtilization: rawTarget,
    intent: getUtilization(marketData.state) > rawTarget ? 'allocate' : 'deallocate',
    clearsMinDelta: () => clearsMinDelta
  })

// Every market converges on 50% utilization and always clears the gate.
const toHalf: Classify = toTarget((50n * WAD) / 100n)

describe('createReconciler', () => {
  it('clamps a WAD target so no leg drains a market to zero free liquidity', () => {
    // A decayed-rateAtTarget cold market can classify with lowerBound = WAD: unclamped, the
    // deallocation sizes to the market's ENTIRE free liquidity — exact to the snapshot and
    // unrealizable one accrual later.
    const toWad: Classify = toTarget(WAD)
    const coldMarket = makeMarket({
      utilization: (50n * WAD) / 100n,
      vaultAssets: parseUnits('100000', 6), // the adapter holds the whole market
      rateAtTarget: RATE_AT_TARGET
    })
    const hotMarket = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    // hotMarket sits below the WAD target too — classify it away so coldMarket is the only dealloc
    // and hotMarket the only alloc candidate via a per-market verdict.
    const classify: Classify = marketData =>
      marketData.id === coldMarket.id ? toWad(marketData) : toHalf(marketData)
    const result = makeReconciler(classify)(makeVaultData([coldMarket, hotMarket]))
    expect(result).toBeDefined()
    const deallocation = result!.deallocations.find(l => l.marketId === coldMarket.id)
    expect(deallocation).toBeDefined()
    const freeLiquidity = coldMarket.state.totalSupplyAssets - coldMarket.state.totalBorrowAssets
    expect(deallocation!.assets).toBeLessThan(freeLiquidity)
    expect(deallocation!.assets).toBeGreaterThan(0n)
  })

  it('drops — never inverts — a move the ceiling clamp leaves empty or backwards', () => {
    // Intent says deallocate (raw target WAD), but the market already sits past the clamped
    // ceiling: emitting the clamped leg would flip it into an allocation.
    const nearFullMarket = makeMarket({
      utilization: parseUnits('0.9995', 18),
      vaultAssets: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (50n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const hotMarket = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const classify: Classify = marketData =>
      marketData.id === nearFullMarket.id
        ? toTarget(WAD)(marketData)
        : marketData.id === coldMarket.id
          ? toTarget((80n * WAD) / 100n)(marketData)
          : toHalf(marketData)
    const result = makeReconciler(classify)(makeVaultData([nearFullMarket, coldMarket, hotMarket]))
    expect(result).toBeDefined()
    const legs = [...result!.allocations, ...result!.deallocations]
    expect(legs.some(l => l.marketId === nearFullMarket.id)).toBe(false)
  })

  it('sizes both sides toward the classifier target and emits delta legs', () => {
    const hotMarket = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const result = makeReconciler(toHalf)(makeVaultData([hotMarket, coldMarket]))
    expect(result).toBeDefined()
    expect(result!.deallocations.map(l => l.marketId)).toEqual([coldMarket.id])
    expect(result!.allocations.map(l => l.marketId)).toEqual([hotMarket.id])
    expect(result!.deallocations[0]!.assets).toBeGreaterThan(0n)
    expect(result!.allocations[0]!.assets).toBeGreaterThan(0n)
  })

  it('leaves out markets the classifier returns undefined for', () => {
    const excluded = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const classify: Classify = marketData =>
      marketData.id === excluded.id ? undefined : toHalf(marketData)
    // The only allocation candidate is excluded → one-sided → no plan.
    expect(makeReconciler(classify)(makeVaultData([excluded, coldMarket]))).toBeUndefined()
  })

  it('skips a market sitting exactly at its target', () => {
    const atTarget = makeMarket({
      utilization: (50n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const hotMarket = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const result = makeReconciler(toHalf)(makeVaultData([atTarget, hotMarket, coldMarket]))
    expect(result).toBeDefined()
    const legIds = [...result!.allocations, ...result!.deallocations].map(l => l.marketId)
    expect(legIds).not.toContain(atTarget.id)
  })

  it('arms the min-delta gate only from markets that contribute assets', () => {
    // The only gate-clearing market is cap-exhausted (contributes 0); the contributing pair does
    // not clear the gate → no plan.
    const vaultAssets = parseUnits('500', 6)
    const gateOnlyMarket = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets,
      cap: { absolute: vaultAssets, relative: WAD, allocation: vaultAssets },
      rateAtTarget: RATE_AT_TARGET
    })
    const hotMarket = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const classify: Classify = marketData =>
      toTarget((50n * WAD) / 100n, marketData.id === gateOnlyMarket.id)(marketData)
    expect(
      makeReconciler(classify)(makeVaultData([gateOnlyMarket, hotMarket, coldMarket]))
    ).toBeUndefined()
  })

  it('does not fire off a clearing market whose take is fully trimmed away', () => {
    // hotA (clears) is behind hotB (does not clear) in market order — but the budget check happens
    // per surviving leg: give hotA a leg the budget can't reach. Budget = deallocatable (tiny);
    // hotB (first in order) consumes it entirely, so hotA's clearing move never survives.
    const hotB = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const hotA = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('100', 6),
      supplyAssets: parseUnits('1000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const classify: Classify = marketData =>
      toTarget((50n * WAD) / 100n, marketData.id === hotA.id)(marketData)
    expect(makeReconciler(classify)(makeVaultData([hotB, hotA, coldMarket]))).toBeUndefined()
  })

  it('fires when the clearing market survives trimming (positive control)', () => {
    const hotA = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const hotB = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('100', 6),
      supplyAssets: parseUnits('1000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const classify: Classify = marketData =>
      toTarget((50n * WAD) / 100n, marketData.id === hotA.id)(marketData)
    const result = makeReconciler(classify)(makeVaultData([hotA, hotB, coldMarket]))
    expect(result).toBeDefined()
    expect(result!.allocations.map(l => l.marketId)).toEqual([hotA.id])
  })

  it('clamps deallocations to the allocation total when idle parking is off', () => {
    const hotMarket = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('100', 6),
      supplyAssets: parseUnits('1000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('50000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const result = makeReconciler(toHalf, { allowIdleParking: false })(
      makeVaultData([hotMarket, coldMarket])
    )
    expect(result).toBeDefined()
    const totalAllocated = result!.allocations.reduce((acc, l) => acc + l.assets, 0n)
    const totalDeallocated = result!.deallocations.reduce((acc, l) => acc + l.assets, 0n)
    expect(totalDeallocated).toBe(totalAllocated)
  })

  it('lets allocations exceed deallocations by at most the idle balance', () => {
    const hotMarket = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('40000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('100', 6),
      supplyAssets: parseUnits('1000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const idleAssets = parseUnits('500', 6)
    const result = makeReconciler(toHalf)(makeVaultData([hotMarket, coldMarket], { idleAssets }))
    expect(result).toBeDefined()
    const totalAllocated = result!.allocations.reduce((acc, l) => acc + l.assets, 0n)
    const totalDeallocated = result!.deallocations.reduce((acc, l) => acc + l.assets, 0n)
    expect(totalAllocated).toBeGreaterThan(totalDeallocated)
    expect(totalAllocated).toBeLessThanOrEqual(totalDeallocated + idleAssets)
  })

  it('funds allocations under a full adapter cap only from its own deallocation credits', () => {
    const hotMarket = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const result = makeReconciler(toHalf)(
      makeVaultData([hotMarket, coldMarket], {
        adapterCap: {
          absolute: parseUnits('30000', 6),
          relative: WAD,
          allocation: parseUnits('30000', 6)
        }
      })
    )
    expect(result).toBeDefined()
    const totalAllocated = result!.allocations.reduce((acc, l) => acc + l.assets, 0n)
    const totalDeallocated = result!.deallocations.reduce((acc, l) => acc + l.assets, 0n)
    expect(totalAllocated).toBeGreaterThan(0n)
    expect(totalAllocated).toBeLessThanOrEqual(totalDeallocated)
  })

  it('does not arm off a clearing move trimmed to a fragment (realized delta)', () => {
    // The hot market's FULL move (90% -> 50%) would clear 500 bips easily, but the only funding is
    // a 1-wei deallocation: the realized endpoint barely moves, so the plan must not fire.
    const minDeltaBips = 500
    const gated: Classify = marketData => {
      const target = (50n * WAD) / 100n
      const utilization = getUtilization(marketData.state)
      return {
        targetUtilization: target,
        intent: utilization > target ? 'allocate' : 'deallocate',
        clearsMinDelta: utilizationAfter =>
          Math.abs(wadToBips(utilization - utilizationAfter)) > minDeltaBips
      }
    }
    const hotMarket = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const dustSource = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: 1n,
      rateAtTarget: RATE_AT_TARGET
    })
    expect(makeReconciler(gated)(makeVaultData([hotMarket, dustSource]))).toBeUndefined()

    // Funded control: with a real deallocation source the same classifier fires.
    const realSource = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('100000', 6),
      supplyAssets: parseUnits('200000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const funded = makeReconciler(gated)(makeVaultData([hotMarket, realSource]))
    expect(funded).toBeDefined()

    // Partial-trim boundary: funding covers only part of the hot market's want, but the realized
    // endpoint still clears the threshold — the trimmed leg fires at the trimmed size.
    const partialSource = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('40000', 6),
      supplyAssets: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const partial = makeReconciler(gated)(makeVaultData([hotMarket, partialSource]))
    expect(partial).toBeDefined()
    const hotLeg = partial!.allocations.find(l => l.marketId === hotMarket.id)
    expect(hotLeg).toBeDefined()
    const totalDeallocated = partial!.deallocations.reduce((acc, l) => acc + l.assets, 0n)
    expect(hotLeg!.assets).toBe(totalDeallocated)
  })

  it('trims the smaller side in market order', () => {
    // Two allocation candidates but the single deallocation funds less than both want: the
    // first-in-queue market takes the whole budget.
    const hotA = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const hotB = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('100', 6),
      supplyAssets: parseUnits('1000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const result = makeReconciler(toHalf)(makeVaultData([hotA, hotB, coldMarket]))
    expect(result).toBeDefined()
    expect(result!.allocations.map(l => l.marketId)).toEqual([hotA.id])
  })
})
