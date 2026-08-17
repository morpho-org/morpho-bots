import { getAddress, parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  createDepositPools,
  getCapHeadroom,
  getDepositableAmount,
  getUtilization,
  getWithdrawableAmount,
  percentToWad,
  takeFromPools
} from '../src/math'
import { makeMarket, makeVaultData, RATE_AT_TARGET } from './strategies/helpers'

const WAD = 10n ** 18n

describe('getCapHeadroom', () => {
  const totalAssets = parseUnits('100000', 6)

  it('measures headroom against the on-chain allocation, not accrued assets', () => {
    // allocation lags accrued position assets; headroom must use allocation.
    const cap = {
      absolute: parseUnits('11000', 6),
      relative: WAD,
      allocation: parseUnits('10000', 6)
    }
    const headroom = getCapHeadroom(cap, totalAssets, 100)
    expect(headroom).toBe(parseUnits('1000', 6))
  })

  it('applies the buffer to both cap legs and floors at zero', () => {
    const cap = {
      absolute: parseUnits('10000', 6),
      relative: WAD,
      allocation: parseUnits('10000', 6)
    }
    // Buffered absolute (99.99%) is below the allocation → zero headroom.
    expect(getCapHeadroom(cap, totalAssets, 99.99)).toBe(0n)
  })

  it('binds on the relative cap when it is the smaller ceiling', () => {
    const cap = {
      absolute: parseUnits('50000', 6),
      relative: parseUnits('0.1', 18), // 10% of totalAssets = 10k
      allocation: parseUnits('9000', 6)
    }
    expect(getCapHeadroom(cap, totalAssets, 100)).toBe(parseUnits('1000', 6))
  })
})

describe('getDepositableAmount / getWithdrawableAmount', () => {
  it('bounds deposits by min(utilization headroom, market cap headroom)', () => {
    const vaultAssets = parseUnits('10000', 6)
    const market = makeMarket({
      utilization: (90n * WAD) / 100n,
      vaultAssets,
      cap: { absolute: vaultAssets + parseUnits('100', 6), relative: WAD, allocation: vaultAssets },
      rateAtTarget: RATE_AT_TARGET
    })
    // Utilization headroom to 45% target would be huge; the cap allows only ~100 more.
    const depositable = getDepositableAmount(
      market,
      parseUnits('100000', 6),
      (45n * WAD) / 100n,
      100
    )
    expect(depositable).toBe(parseUnits('100', 6))
  })

  it('bounds withdrawals by the adapter position', () => {
    const market = makeMarket({
      utilization: (45n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    expect(getWithdrawableAmount(market, (90n * WAD) / 100n)).toBe(market.vaultAssets)
  })

  it('returns 0 utilization for an empty market instead of dividing by zero', () => {
    expect(
      getUtilization({
        totalSupplyAssets: 0n,
        totalSupplyShares: 0n,
        totalBorrowAssets: 0n,
        totalBorrowShares: 0n
      })
    ).toBe(0n)
  })
})

describe('deposit pools', () => {
  it('consumes the adapter pool and the per-collateral pool independently', () => {
    const market = makeMarket({
      utilization: (50n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const collateral = getAddress(market.params.collateralToken)
    const vaultData = makeVaultData([market], {
      idleAssets: parseUnits('1000', 6), // raises totalAssets so the 100% relative caps have headroom
      adapterCap: {
        absolute: parseUnits('10300', 6),
        relative: WAD,
        allocation: parseUnits('10000', 6)
      },
      collateralCaps: {
        [collateral]: {
          absolute: parseUnits('10200', 6),
          relative: WAD,
          allocation: parseUnits('10000', 6)
        }
      }
    })
    const pools = createDepositPools(vaultData, 100)
    // Collateral pool (200) binds before the adapter pool (300).
    expect(takeFromPools(pools, collateral, parseUnits('500', 6))).toBe(parseUnits('200', 6))
    // Both pools are now drained for this collateral.
    expect(takeFromPools(pools, collateral, parseUnits('500', 6))).toBe(0n)
    expect(pools.adapter).toBe(parseUnits('100', 6))
  })

  it('treats an unknown collateral as having zero headroom', () => {
    const market = makeMarket({
      utilization: (50n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const pools = createDepositPools(makeVaultData([market]), 100)
    expect(takeFromPools(pools, getAddress(`0x${'77'.repeat(20)}`), parseUnits('1', 6))).toBe(0n)
  })
})

describe('percentToWad', () => {
  it('scales percentages to WAD fractions', () => {
    expect(percentToWad(100)).toBe(WAD)
    expect(percentToWad(99.99)).toBe(parseUnits('0.9999', 18))
  })
})
