import { wholePercentToWAD } from '@repo/utils'
import { getAddress, parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  createDepositPools,
  creditPools,
  getCapHeadroom,
  getDepositableAmount,
  getUtilization,
  getWithdrawableAmount,
  takeFromPools
} from '../src/math'
import { makeMarket, makeVaultData, RATE_AT_TARGET } from './helpers'

const WAD = 10n ** 18n

describe('getCapHeadroom', () => {
  const totalAssets = parseUnits('100000', 6)

  it('measures headroom from the caller-provided basis', () => {
    const cap = {
      absolute: parseUnits('11000', 6),
      relative: WAD,
      allocation: parseUnits('10000', 6)
    }
    // The accrued position (basis) sits above the stored allocation — headroom shrinks with it,
    // because allocate trues allocation up to the accrued position before the cap check.
    expect(getCapHeadroom(cap, parseUnits('10500', 6), totalAssets, WAD)).toBe(parseUnits('500', 6))
  })

  it('treats a WAD relative cap as no relative constraint, never a 100% ceiling', () => {
    // The production shape: fully deployed vault, relativeCap = WAD, huge absolute cap. A binding
    // 100%-of-totalAssets reading would return ~0 here and silently no-op the bot forever.
    const cap = { absolute: parseUnits('1000000', 6), relative: WAD, allocation: totalAssets }
    expect(getCapHeadroom(cap, totalAssets, totalAssets, WAD)).toBe(parseUnits('900000', 6))
  })

  it('applies the buffer and floors at zero', () => {
    const cap = {
      absolute: parseUnits('10000', 6),
      relative: WAD,
      allocation: parseUnits('10000', 6)
    }
    // Buffered absolute (99.99%) is below the basis → zero headroom.
    expect(getCapHeadroom(cap, parseUnits('10000', 6), totalAssets, wholePercentToWAD(99.99))).toBe(
      0n
    )
  })

  it('binds on a sub-WAD relative cap when it is the smaller ceiling', () => {
    const cap = {
      absolute: parseUnits('50000', 6),
      relative: parseUnits('0.1', 18), // 10% of totalAssets = 10k
      allocation: parseUnits('9000', 6)
    }
    expect(getCapHeadroom(cap, parseUnits('9000', 6), totalAssets, WAD)).toBe(parseUnits('1000', 6))
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
      WAD
    )
    expect(depositable).toBe(parseUnits('100', 6))

    // Accrual drift: the position accrued 40 past the stored allocation; allocate trues the
    // allocation up before the cap check, so the drift eats into the headroom.
    const drifted = {
      ...market,
      cap: { ...market.cap, allocation: vaultAssets - parseUnits('40', 6) }
    }
    expect(getDepositableAmount(drifted, parseUnits('100000', 6), (45n * WAD) / 100n, WAD)).toBe(
      parseUnits('100', 6)
    )
    const driftedAboveCapBase = { ...market, vaultAssets: vaultAssets + parseUnits('40', 6) }
    expect(
      getDepositableAmount(driftedAboveCapBase, parseUnits('100000', 6), (45n * WAD) / 100n, WAD)
    ).toBe(parseUnits('60', 6))
  })

  it('bounds withdrawals by the adapter position', () => {
    const market = makeMarket({
      utilization: (45n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    expect(getWithdrawableAmount(market, (90n * WAD) / 100n)).toBe(market.vaultAssets)
  })

  it('sizes both directions to zero for a 0 target instead of dividing by zero', () => {
    const market = makeMarket({
      utilization: (45n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    expect(getDepositableAmount(market, parseUnits('100000', 6), 0n, WAD)).toBe(0n)
    const emptyMarket = makeMarket({
      utilization: 0n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    expect(getWithdrawableAmount(emptyMarket, 0n)).toBe(0n)
  })

  it('returns 0 utilization for an empty market instead of dividing by zero', () => {
    expect(getUtilization({ totalSupplyAssets: 0n, totalBorrowAssets: 0n })).toBe(0n)
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
    const pools = createDepositPools(vaultData, WAD)
    // Collateral pool (200) binds before the adapter pool (300).
    expect(takeFromPools(pools, collateral, parseUnits('500', 6))).toBe(parseUnits('200', 6))
    // Both pools are now drained for this collateral.
    expect(takeFromPools(pools, collateral, parseUnits('500', 6))).toBe(0n)
    expect(pools.adapter.headroom).toBe(parseUnits('100', 6))
  })

  it('repays an existing over-cap deficit before crediting deallocations as headroom', () => {
    const market = makeMarket({
      utilization: (50n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const collateral = getAddress(market.params.collateralToken)
    const vaultData = makeVaultData([market], {
      // The adapter allocation already sits 100 OVER its cap (accrual, or a curator lowering the
      // cap): a deallocation must relieve that overage before any of it becomes new headroom.
      adapterCap: {
        absolute: parseUnits('10000', 6),
        relative: WAD,
        allocation: parseUnits('10100', 6)
      }
    })
    const pools = createDepositPools(vaultData, WAD)
    expect(pools.adapter).toEqual({ headroom: 0n, deficit: parseUnits('100', 6) })
    creditPools(pools, collateral, parseUnits('150', 6))
    // Only the 50 past the deficit is drawable — allocating the full 150 back would restore the
    // over-cap balance the deallocation just relieved.
    expect(takeFromPools(pools, collateral, parseUnits('1000', 6))).toBe(parseUnits('50', 6))
  })

  it("includes every market's accrual drift in the aggregate pool bases", () => {
    const vaultAssets = parseUnits('10000', 6)
    const market = makeMarket({
      utilization: (50n * WAD) / 100n,
      vaultAssets,
      // Position accrued 100 past the stored market allocation.
      cap: {
        absolute: parseUnits('50000', 6),
        relative: WAD,
        allocation: vaultAssets - parseUnits('100', 6)
      },
      rateAtTarget: RATE_AT_TARGET
    })
    const vaultData = makeVaultData([market], {
      adapterCap: {
        absolute: parseUnits('10300', 6),
        relative: WAD,
        allocation: parseUnits('10000', 6)
      }
    })
    const pools = createDepositPools(vaultData, WAD)
    // Adapter basis = stored 10000 + drift 100 → headroom 200 instead of 300.
    expect(pools.adapter.headroom).toBe(parseUnits('200', 6))
  })

  it('credits deallocation legs back into both pools', () => {
    const market = makeMarket({
      utilization: (50n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const collateral = getAddress(market.params.collateralToken)
    const vaultData = makeVaultData([market], {
      adapterCap: {
        absolute: parseUnits('10000', 6),
        relative: WAD,
        allocation: parseUnits('10000', 6)
      }
    })
    const pools = createDepositPools(vaultData, WAD)
    expect(pools.adapter.headroom).toBe(0n)
    creditPools(pools, collateral, parseUnits('700', 6))
    expect(takeFromPools(pools, collateral, parseUnits('1000', 6))).toBe(parseUnits('700', 6))
  })

  it('treats an unknown collateral as having zero headroom', () => {
    const market = makeMarket({
      utilization: (50n * WAD) / 100n,
      vaultAssets: parseUnits('10000', 6),
      rateAtTarget: RATE_AT_TARGET
    })
    const pools = createDepositPools(makeVaultData([market]), WAD)
    expect(takeFromPools(pools, getAddress(`0x${'77'.repeat(20)}`), parseUnits('1', 6))).toBe(0n)
  })
})
