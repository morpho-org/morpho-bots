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
