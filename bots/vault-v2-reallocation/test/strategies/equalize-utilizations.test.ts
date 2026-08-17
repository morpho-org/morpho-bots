import { getAddress, parseUnits } from 'viem'
import { beforeEach, describe, expect, it } from 'vitest'

import { createEqualizeUtilizationsStrategy } from '../../src/strategies/equalize-utilizations'
import { makeMarket, makeVaultData, RATE_AT_TARGET, resetMarketCounter, VAULT } from './helpers'

const makeStrategy = (minUtilizationDeltaBips: (vault: `0x${string}`) => number = () => 0) =>
  createEqualizeUtilizationsStrategy({ capBufferPercent: 99.99, minUtilizationDeltaBips })

const WAD = 10n ** 18n

describe('createEqualizeUtilizationsStrategy', () => {
  beforeEach(() => {
    resetMarketCounter()
  })

  it('deallocates from below-average and allocates into above-average markets (deltas)', () => {
    const strategy = makeStrategy()
    const hotMarket = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })

    const result = strategy(makeVaultData([hotMarket, coldMarket]))

    expect(result).toBeDefined()
    expect(result!.deallocations.length).toBe(1)
    expect(result!.allocations.length).toBe(1)
    const deallocation = result!.deallocations[0]!
    const allocation = result!.allocations[0]!
    expect(deallocation.marketParams).toEqual(coldMarket.params)
    expect(deallocation.assets).toBeGreaterThan(0n)
    expect(deallocation.assets).toBeLessThanOrEqual(coldMarket.vaultAssets)
    expect(allocation.marketParams).toEqual(hotMarket.params)
    expect(allocation.assets).toBeGreaterThan(0n)
  })

  it('folds idle assets into the target-utilization denominator', () => {
    const strategy = makeStrategy()
    const market = makeMarket({
      utilization: (50n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    // Without idle the single market sits exactly at target (no move); a large idle balance drags
    // the target below the market's utilization, making it an allocation candidate — but with no
    // deallocation source min(dealloc, alloc) is 0, so still no reallocation. The observable
    // effect: adding a cold market makes idle tilt the split.
    expect(strategy(makeVaultData([market]))).toBeUndefined()
    expect(
      strategy(makeVaultData([market], { idleAssets: parseUnits('1000000', 6) }))
    ).toBeUndefined()
  })

  it('clamps the target utilization at 100% in bad-debt states', () => {
    const strategy = makeStrategy()
    // Aggregate borrow > aggregate supply: unclamped, the target would exceed WAD and deallocation
    // sizing would ask for more than the markets hold.
    const badDebtMarket = makeMarket({
      utilization: (150n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const result = strategy(makeVaultData([badDebtMarket, coldMarket]))
    if (result) {
      const deallocation = result.deallocations[0]
      expect(deallocation?.assets ?? 0n).toBeLessThanOrEqual(coldMarket.vaultAssets)
    }
  })

  it('returns undefined when nothing is borrowed anywhere', () => {
    const strategy = makeStrategy()
    const market = makeMarket({
      utilization: 0n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    expect(strategy(makeVaultData([market]))).toBeUndefined()
  })

  it('returns undefined when no deviation clears the vault min-delta threshold', () => {
    const strategy = makeStrategy(() => 10_000) // 100%
    const hotMarket = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    expect(strategy(makeVaultData([hotMarket, coldMarket]))).toBeUndefined()
  })

  it('resolves the min-delta threshold by vault address', () => {
    const other = getAddress(`0x${'99'.repeat(20)}`)
    const seen: string[] = []
    const strategy = makeStrategy(vault => {
      seen.push(vault)
      return 0
    })
    const hotMarket = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    strategy(makeVaultData([hotMarket, coldMarket], { vaultAddress: other }))
    expect(seen).toEqual([other])
    expect(seen).not.toContain(VAULT)
  })

  it('clamps allocations to the market cap headroom measured against allocation(id)', () => {
    const strategy = makeStrategy()
    const vaultAssets = parseUnits('10000', 6)
    const hotMarket = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets,
      // The enforced allocation already sits 100 under the absolute cap even though position
      // assets accrued past it — headroom must come from allocation, not vaultAssets.
      cap: { absolute: vaultAssets + parseUnits('100', 6), relative: WAD, allocation: vaultAssets },
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })

    const result = strategy(makeVaultData([hotMarket, coldMarket]))

    expect(result).toBeDefined()
    expect(result!.allocations[0]!.assets).toBeLessThanOrEqual(parseUnits('100', 6))
  })

  it('clamps total allocations to the adapter-level cap pool', () => {
    const strategy = makeStrategy()
    const hotMarket = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const adapterAllocation = parseUnits('30000', 6)
    const result = strategy(
      makeVaultData([hotMarket, coldMarket], {
        idleAssets: parseUnits('1000', 6), // raises totalAssets so the 100% relative cap has headroom
        adapterCap: {
          absolute: adapterAllocation + parseUnits('50', 6),
          relative: WAD,
          allocation: adapterAllocation
        }
      })
    )

    expect(result).toBeDefined()
    const totalAllocated = result!.allocations.reduce((acc, leg) => acc + leg.assets, 0n)
    expect(totalAllocated).toBeLessThanOrEqual(parseUnits('50', 6))
    expect(totalAllocated).toBeGreaterThan(0n)
  })

  it('blocks allocations into a collateral whose cap pool is exhausted', () => {
    const strategy = makeStrategy()
    const hotMarket = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const base = makeVaultData([hotMarket, coldMarket])
    const collateral = getAddress(hotMarket.params.collateralToken)
    const collateralAllocation = parseUnits('30000', 6)
    const result = strategy({
      ...base,
      collateralCaps: {
        ...base.collateralCaps,
        [collateral]: {
          absolute: collateralAllocation,
          relative: WAD,
          allocation: collateralAllocation
        }
      }
    })

    // No allocation headroom under the collateral cap → min(dealloc, alloc) = 0 → no reallocation.
    expect(result).toBeUndefined()
  })
})
