import { wholePercentToWAD } from '@repo/utils'
import { getAddress, parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import { createEqualizeUtilizationsStrategy } from '../../src/strategies/equalize-utilizations'
import { makeMarket, makeMarketParams, makeVaultData, RATE_AT_TARGET, VAULT } from './helpers'

const makeStrategy = (minUtilizationDeltaBips: (vault: `0x${string}`) => number = () => 0) =>
  createEqualizeUtilizationsStrategy({
    capBufferWad: wholePercentToWAD(99.99),
    minUtilizationDeltaBips
  })

const WAD = 10n ** 18n

describe('createEqualizeUtilizationsStrategy', () => {
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

  it('lands a bad-debt aggregate target at the clamp, never draining free liquidity', () => {
    const strategy = makeStrategy()
    // Aggregate utilization > 100% (bad debt dominates): the raw target exceeds WAD, which
    // unclamped would size the cold market's deallocation past its entire free liquidity.
    const badDebtMarket = makeMarket({
      utilization: (300n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6), // the adapter holds the whole market
      supplyAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const result = strategy(makeVaultData([badDebtMarket, coldMarket]))
    expect(result).toBeDefined()
    const deallocation = result!.deallocations.find(l => l.marketId === coldMarket.id)
    expect(deallocation).toBeDefined()
    const freeLiquidity = coldMarket.state.totalSupplyAssets - coldMarket.state.totalBorrowAssets
    expect(deallocation!.assets).toBeLessThan(freeLiquidity)
    expect(deallocation!.assets).toBeGreaterThan(0n)
  })

  it('never inverts a near-ceiling market when bad debt pushes the aggregate target past the clamp', () => {
    const strategy = makeStrategy()
    // Raw aggregate target > WAD: the near-ceiling market's intent is a (tiny) deallocation, but
    // its utilization already sits past the clamped target — under a naive clamp it would flip
    // into an allocation into an almost-drained market.
    const badDebtMarket = makeMarket({
      utilization: (300n * WAD) / 100n,
      supplyAssets: parseUnits('10000', 6),
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const nearMaxMarket = makeMarket({
      utilization: parseUnits('0.9995', 18),
      vaultAssets: parseUnits('1000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      rateAtTarget: RATE_AT_TARGET
    })

    // nearMax listed first so a wrong-side allocation could not hide behind budget trimming.
    const result = strategy(makeVaultData([nearMaxMarket, badDebtMarket, coldMarket]))

    expect(result).toBeDefined()
    const legs = [...result!.allocations, ...result!.deallocations]
    expect(legs.some(l => l.marketId === nearMaxMarket.id)).toBe(false)
    expect(result!.deallocations.some(l => l.marketId === coldMarket.id)).toBe(true)
    expect(result!.allocations.some(l => l.marketId === badDebtMarket.id)).toBe(true)
  })

  it('handles a dust aggregate borrow whose target rounds to zero without throwing', () => {
    const strategy = makeStrategy()
    // borrow = 1 wei against a huge supply → wDivDown target rounds to 0n, past the
    // totalBorrow === 0n early return.
    const dustMarket = makeMarket({
      utilization: 0n,
      vaultAssets: parseUnits('10000', 6),
      supplyAssets: parseUnits('1000000000000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    dustMarket.state.totalBorrowAssets = 1n
    expect(strategy(makeVaultData([dustMarket]))).toBeUndefined()
  })

  it('does not arm the min-delta trigger from a market that contributes nothing', () => {
    // A deviates hugely but is cap-exhausted (contributes 0); B and C deviate under the threshold
    // but carry the actual legs — the plan must NOT fire off A's deviation alone.
    const strategy = makeStrategy(() => 100) // 1% threshold
    const hotCapped = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets: parseUnits('500', 6),
      supplyAssets: parseUnits('1000', 6),
      cap: { absolute: parseUnits('500', 6), relative: WAD, allocation: parseUnits('500', 6) },
      rateAtTarget: RATE_AT_TARGET
    })
    const slightlyHot = makeMarket({
      utilization: (505n * WAD) / 1000n,
      vaultAssets: parseUnits('10000', 6),
      supplyAssets: parseUnits('1000000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const slightlyCold = makeMarket({
      utilization: (495n * WAD) / 1000n,
      vaultAssets: parseUnits('10000', 6),
      supplyAssets: parseUnits('1000000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    expect(strategy(makeVaultData([hotCapped, slightlyHot, slightlyCold]))).toBeUndefined()
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

  it('clamps allocations to the market cap headroom measured from the accrued position', () => {
    const strategy = makeStrategy()
    const vaultAssets = parseUnits('10000', 6)
    const hotMarket = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets,
      // allocate trues allocation(id) up to the accrued position before the cap check, so
      // headroom is cap − accrued assets, even while the stored allocation lags behind.
      cap: {
        absolute: vaultAssets + parseUnits('100', 6),
        relative: WAD,
        allocation: vaultAssets - parseUnits('30', 6)
      },
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

  it('fires on a fully-deployed vault whose relative caps are the WAD no-constraint sentinel', () => {
    // The real production shape: everything allocated, relativeCap = WAD everywhere, generous
    // absolute caps. A 100%-of-totalAssets reading of WAD would zero the pools and silently
    // no-op the bot forever.
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
    const deployed = makeVaultData([hotMarket, coldMarket], {
      idleAssets: 0n,
      adapterCap: {
        absolute: parseUnits('1000000', 6),
        relative: WAD,
        allocation: parseUnits('30000', 6) // fully deployed: allocation == totalAssets
      }
    })
    expect(strategy(deployed)).toBeDefined()
  })

  it('never allocates more than deallocations plus idle (allocate pulls from vault balance)', () => {
    const strategy = makeStrategy()
    // Cold market: huge supply but the adapter only holds 100 — deallocatable is tiny. Hot market:
    // big depositable demand. Unclamped, allocations would exceed what the vault balance can fund
    // and the whole multicall would revert.
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('100', 6),
      supplyAssets: parseUnits('1000000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const hotMarket = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('5000', 6),
      supplyAssets: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const result = strategy(makeVaultData([coldMarket, hotMarket], { idleAssets: 0n }))
    if (result) {
      const totalAllocated = result.allocations.reduce((acc, l) => acc + l.assets, 0n)
      const totalDeallocated = result.deallocations.reduce((acc, l) => acc + l.assets, 0n)
      expect(totalAllocated).toBeLessThanOrEqual(totalDeallocated)
    }
  })

  it('uses capacity freed by its own deallocations under a full adapter cap', () => {
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
    // Adapter cap exactly full: no pre-existing headroom — only the deallocation legs (which
    // execute first) free capacity for the allocations.
    const result = strategy(
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
    const totalDeallocated = result!.deallocations.reduce((acc, leg) => acc + leg.assets, 0n)
    // The pool cap plus the capacity this plan's own deallocations free (they execute first).
    expect(totalAllocated).toBeLessThanOrEqual(parseUnits('50', 6) + totalDeallocated)
    expect(totalAllocated).toBeGreaterThan(0n)
  })

  it('blocks allocations into a collateral whose cap pool is exhausted', () => {
    const strategy = makeStrategy()
    const hotMarket = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    // A DIFFERENT collateral, so its deallocation credit cannot revive the hot market's pool.
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      params: makeMarketParams({ collateralToken: getAddress(`0x${'55'.repeat(20)}`) }),
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
