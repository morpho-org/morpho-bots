import type { Address, Hex } from 'viem'

import { MathLib } from '@morpho-org/blue-sdk'

import type { Reallocation, ReallocationAction, Strategy } from './strategy'

import {
  apyToRate,
  createDepositPools,
  getDepositableAmount,
  getUtilization,
  getWithdrawableAmount,
  rateToApy,
  rateToUtilization,
  takeFromPools,
  utilizationToRate
} from '../math'

export type ApyRangeConfig = {
  /** Whether excess deallocations may be parked in the vault's idle balance. */
  allowIdleReallocation: boolean
  capBufferPercent: number
  /** WAD-scaled borrow-APY bounds for (vault, market). */
  apyRange: (vault: Address, marketId: Hex) => { min: bigint; max: bigint }
  /** Firing threshold: at least one market's implied APY move must exceed this (bips). */
  minApyDeltaBips: (vault: Address, marketId: Hex) => number
}

const { min } = MathLib

/**
 * Keeps each market's borrow APY inside its configured range: converts the APY bounds to
 * utilization bounds via the AdaptiveCurveIRM inverse, deallocates from markets below range,
 * allocates into markets above range. Allocations may exceed deallocations by up to the vault's
 * idle balance; excess deallocations park in idle unless `allowIdleReallocation` is off, in which
 * case they are clamped to the allocation total.
 *
 * Only markets on the canonical AdaptiveCurveIRM participate — the inversion is meaningless without
 * a real `rateAtTarget`, so a foreign-IRM market is excluded from both legs rather than misread
 * (see `isAdaptiveCurve` on the market data). Allocations respect the market, adapter-level, and
 * collateral-level caps.
 */
export const createApyRangeStrategy = (config: ApyRangeConfig): Strategy => {
  return vaultData => {
    const vault = vaultData.vaultAddress
    const marketsData = vaultData.marketsData.filter(marketData => marketData.isAdaptiveCurve)

    let totalAmountToDeallocate = 0n
    let totalAmountToAllocate = 0n

    let didExceedMinApyDelta = false // true if *at least one* market moves enough

    // Both passes iterate markets in the same order with the same clamps, so the totals gathered
    // here (pool-clamped) equal what the leg pass can actually emit.
    const sizingPools = createDepositPools(vaultData, config.capBufferPercent)
    for (const marketData of marketsData) {
      const apyRange = config.apyRange(vault, marketData.id)
      const upperUtilizationBound = rateToUtilization(
        apyToRate(apyRange.max),
        marketData.rateAtTarget
      )
      const lowerUtilizationBound = rateToUtilization(
        apyToRate(apyRange.min),
        marketData.rateAtTarget
      )
      const utilization = getUtilization(marketData.state)

      if (utilization > upperUtilizationBound) {
        totalAmountToAllocate += takeFromPools(
          sizingPools,
          marketData.params.collateralToken,
          getDepositableAmount(
            marketData,
            vaultData.totalAssets,
            upperUtilizationBound,
            config.capBufferPercent
          )
        )
        const apyDelta =
          rateToApy(utilizationToRate(upperUtilizationBound, marketData.rateAtTarget)) -
          rateToApy(utilizationToRate(utilization, marketData.rateAtTarget))
        didExceedMinApyDelta ||=
          Math.abs(Number(apyDelta / 1_000_000_000n) / 1e5) >
          config.minApyDeltaBips(vault, marketData.id)
      } else if (utilization < lowerUtilizationBound) {
        totalAmountToDeallocate += getWithdrawableAmount(marketData, lowerUtilizationBound)
        const apyDelta =
          rateToApy(utilizationToRate(lowerUtilizationBound, marketData.rateAtTarget)) -
          rateToApy(utilizationToRate(utilization, marketData.rateAtTarget))
        didExceedMinApyDelta ||=
          Math.abs(Number(apyDelta / 1_000_000_000n) / 1e5) >
          config.minApyDeltaBips(vault, marketData.id)
      }
    }

    if (totalAmountToDeallocate > totalAmountToAllocate && !config.allowIdleReallocation) {
      totalAmountToDeallocate = totalAmountToAllocate
    } else if (totalAmountToAllocate > totalAmountToDeallocate) {
      totalAmountToAllocate =
        totalAmountToDeallocate +
        min(totalAmountToAllocate - totalAmountToDeallocate, vaultData.idleAssets)
    }

    if (min(totalAmountToDeallocate, totalAmountToAllocate) === 0n || !didExceedMinApyDelta) {
      return undefined
    }

    let remainingAmountToDeallocate = totalAmountToDeallocate
    let remainingAmountToAllocate = totalAmountToAllocate

    const allocations: ReallocationAction[] = []
    const deallocations: ReallocationAction[] = []

    const legPools = createDepositPools(vaultData, config.capBufferPercent)
    for (const marketData of marketsData) {
      const apyRange = config.apyRange(vault, marketData.id)
      const upperUtilizationBound = rateToUtilization(
        apyToRate(apyRange.max),
        marketData.rateAtTarget
      )
      const lowerUtilizationBound = rateToUtilization(
        apyToRate(apyRange.min),
        marketData.rateAtTarget
      )
      const utilization = getUtilization(marketData.state)

      if (utilization > upperUtilizationBound) {
        const desired = min(
          getDepositableAmount(
            marketData,
            vaultData.totalAssets,
            upperUtilizationBound,
            config.capBufferPercent
          ),
          remainingAmountToAllocate
        )
        const toAllocate = takeFromPools(legPools, marketData.params.collateralToken, desired)
        remainingAmountToAllocate -= toAllocate
        if (toAllocate > 0n) {
          allocations.push({ marketParams: marketData.params, assets: toAllocate })
        }
      } else if (utilization < lowerUtilizationBound) {
        const toDeallocate = min(
          getWithdrawableAmount(marketData, lowerUtilizationBound),
          remainingAmountToDeallocate
        )
        remainingAmountToDeallocate -= toDeallocate
        if (toDeallocate > 0n) {
          deallocations.push({ marketParams: marketData.params, assets: toDeallocate })
        }
      }

      if (remainingAmountToDeallocate === 0n && remainingAmountToAllocate === 0n) break
    }

    return { allocations, deallocations } satisfies Reallocation
  }
}
