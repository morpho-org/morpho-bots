import { getAddress, maxUint256, parseUnits, zeroAddress } from 'viem'
import { beforeEach, describe, expect, it } from 'vitest'

import { createEqualizeUtilizationsStrategy } from '../../src/strategies/equalize-utilizations'
import {
  makeIdleMarket,
  makeMarket,
  makeVaultData,
  RATE_AT_TARGET,
  resetMarketCounter,
  VAULT
} from './helpers'

const makeStrategy = (minUtilizationDeltaBips: (vault: `0x${string}`) => number = () => 0) =>
  createEqualizeUtilizationsStrategy({
    capBufferPercent: 99.99,
    minUtilizationDeltaBips
  })

const WAD = 10n ** 18n

describe('createEqualizeUtilizationsStrategy', () => {
  beforeEach(() => {
    resetMarketCounter()
  })

  it('withdraws from below-average and deposits into above-average markets', () => {
    const strategy = makeStrategy()
    const hotMarket = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })

    const result = strategy(makeVaultData([hotMarket, coldMarket]))

    expect(result).toBeDefined()
    expect(result!.length).toBe(2)
    const withdrawal = result![0]!
    const deposit = result![1]!
    expect(withdrawal.marketParams).toEqual(coldMarket.params)
    expect(withdrawal.assets).toBeLessThan(coldMarket.vaultAssets)
    expect(deposit.marketParams).toEqual(hotMarket.params)
    expect(deposit.assets).toBe(maxUint256)
  })

  it('excludes the idle market from the target computation and the result', () => {
    const strategy = makeStrategy()
    const hotMarket = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const idleMarket = makeIdleMarket(parseUnits('50000', 6))

    const result = strategy(makeVaultData([hotMarket, coldMarket, idleMarket]))

    expect(result).toBeDefined()
    expect(result!.map(r => r.marketParams.collateralToken)).not.toContain(zeroAddress)
  })

  it('returns undefined when every market already sits at the average', () => {
    const strategy = makeStrategy()
    const utilization = (50n * WAD) / 100n
    const market1 = makeMarket({
      utilization,
      vaultAssets: parseUnits('10000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const market2 = makeMarket({
      utilization,
      vaultAssets: parseUnits('10000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    expect(strategy(makeVaultData([market1, market2]))).toBeUndefined()
  })

  it('returns undefined when nothing is borrowed anywhere', () => {
    const strategy = makeStrategy()
    const market = makeMarket({
      utilization: 0n,
      vaultAssets: parseUnits('10000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    expect(strategy(makeVaultData([market]))).toBeUndefined()
  })

  it('returns undefined when no deviation clears the vault min-delta threshold', () => {
    const strategy = makeStrategy(() => 10_000) // 100%
    const hotMarket = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    expect(strategy(makeVaultData([hotMarket, coldMarket]))).toBeUndefined()
  })

  it('emits exactly one maxUint256 leg when one market absorbs the whole deposit budget', () => {
    const strategy = makeStrategy()
    // The first hot market's cap headroom exceeds the total withdrawable, so it takes the entire
    // budget and the second hot market must contribute no leg at all — a second `maxUint256` deposit
    // would tell MetaMorpho to sweep the vault's idle assets into it too.
    const hot1 = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets: 0n,
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const hot2 = makeMarket({
      utilization: (95n * WAD) / 100n,
      vaultAssets: 0n,
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const cold = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('5000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })

    const result = strategy(makeVaultData([hot1, hot2, cold]))

    expect(result).toBeDefined()
    expect(result!.filter(r => r.assets === maxUint256).length).toBe(1)
    expect(result!.map(r => r.marketParams)).not.toContainEqual(hot2.params)
  })

  it('contributes no leg for a market already sitting at the target', () => {
    const strategy = makeStrategy()
    const hot = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const cold = makeMarket({
      utilization: (30n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    // Aggregate utilization is (90 + 30 + 60) / 3 = 60%, so this market is exactly at target.
    const atTarget = makeMarket({
      utilization: (60n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })

    const result = strategy(makeVaultData([hot, cold, atTarget]))

    expect(result).toBeDefined()
    expect(result!.map(r => r.marketParams)).not.toContainEqual(atTarget.params)
  })

  it('clamps the target at 100% utilization in a bad-debt state', () => {
    const strategy = makeStrategy()
    // Aggregate utilization here is 125%. Withdrawals sized toward a >100% target ask for liquidity
    // the markets do not hold, so every resulting plan reverts.
    const overBorrowed = makeMarket({
      utilization: 2n * WAD,
      vaultAssets: 0n,
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const under = makeMarket({
      utilization: (50n * WAD) / 100n,
      vaultAssets: parseUnits('100000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })

    const result = strategy(makeVaultData([overBorrowed, under]))

    expect(result).toBeDefined()
    const withdrawal = result!.find(r => r.marketParams === under.params)!
    // Toward a 100% target: 100k * (1 - 0.5/1.0) = 50k moved, leaving 50k. An unclamped 125% target
    // would move 60k, past the market's available liquidity.
    expect(withdrawal.assets).toBe(parseUnits('50000', 6))
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
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const coldMarket = makeMarket({
      utilization: (10n * WAD) / 100n,
      vaultAssets: parseUnits('20000', 6),
      cap: parseUnits('100000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    strategy(makeVaultData([hotMarket, coldMarket], other))
    expect(seen).toEqual([other])
    expect(seen).not.toContain(VAULT)
  })
})
