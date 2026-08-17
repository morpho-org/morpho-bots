import type { Address } from 'viem'

import { MathLib } from '@morpho-org/blue-sdk'
import { zeroAddress } from 'viem'

import type { Reallocation, ReallocationAction, Strategy } from './strategy'

import {
  createDepositPools,
  getDepositableAmount,
  getUtilization,
  getWithdrawableAmount,
  takeFromPools
} from '../math'

type EqualizeUtilizationsConfig = {
  capBufferPercent: number
  /** Firing threshold: at least one market's utilization must deviate from target by this (bips). */
  minUtilizationDeltaBips: (vault: Address) => number
}

const { min, wDivDown } = MathLib

/**
 * Converges every market toward the vault-wide average utilization
 * (`sum(totalBorrowAssets) / (sum(totalSupplyAssets) + idleAssets)` — idle counts as deployable
 * supply): deallocates from markets below it, allocates into markets above it. Legs need not
 * balance — the difference flows through the vault's idle balance. Fires only when at least one
 * market's deviation exceeds the vault's min-delta threshold. Allocations respect the market,
 * adapter-level, and collateral-level caps.
 */
export const createEqualizeUtilizationsStrategy = (
  config: EqualizeUtilizationsConfig
): Strategy => {
  return vaultData => {
    const marketsData = vaultData.marketsData.filter(
      marketData => marketData.params.collateralToken !== zeroAddress
    )

    const totalSupply = marketsData.reduce(
      (acc, m) => acc + m.state.totalSupplyAssets,
      vaultData.idleAssets
    )
    const totalBorrow = marketsData.reduce((acc, m) => acc + m.state.totalBorrowAssets, 0n)
    // Nothing supplied or nothing borrowed anywhere — every market already sits at the (degenerate)
    // target, and the per-market target math below would divide by zero.
    if (totalSupply === 0n || totalBorrow === 0n) return undefined
    const targetUtilization = wDivDown(totalBorrow, totalSupply)

    let totalAmountToDeallocate = 0n
    let totalAmountToAllocate = 0n

    let didExceedMinUtilizationDelta = false // true if *at least one* market moves enough
    const minUtilizationDeltaBips = config.minUtilizationDeltaBips(vaultData.vaultAddress)

    // Both passes iterate markets in the same order with the same clamps, so the totals gathered
    // here (pool-clamped) equal what the leg pass can actually emit.
    const sizingPools = createDepositPools(vaultData, config.capBufferPercent)
    for (const marketData of marketsData) {
      const utilization = getUtilization(marketData.state)
      if (utilization > targetUtilization) {
        totalAmountToAllocate += takeFromPools(
          sizingPools,
          marketData.params.collateralToken,
          getDepositableAmount(
            marketData,
            vaultData.totalAssets,
            targetUtilization,
            config.capBufferPercent
          )
        )
      } else {
        totalAmountToDeallocate += getWithdrawableAmount(marketData, targetUtilization)
      }

      didExceedMinUtilizationDelta ||=
        Math.abs(Number((utilization - targetUtilization) / 1_000_000_000n) / 1e5) >
        minUtilizationDeltaBips
    }

    if (
      min(totalAmountToDeallocate, totalAmountToAllocate) === 0n ||
      !didExceedMinUtilizationDelta
    ) {
      return undefined
    }

    let remainingAmountToDeallocate = totalAmountToDeallocate
    let remainingAmountToAllocate = totalAmountToAllocate

    const allocations: ReallocationAction[] = []
    const deallocations: ReallocationAction[] = []

    const legPools = createDepositPools(vaultData, config.capBufferPercent)
    for (const marketData of marketsData) {
      const utilization = getUtilization(marketData.state)

      if (utilization > targetUtilization) {
        const desired = min(
          getDepositableAmount(
            marketData,
            vaultData.totalAssets,
            targetUtilization,
            config.capBufferPercent
          ),
          remainingAmountToAllocate
        )
        const toAllocate = takeFromPools(legPools, marketData.params.collateralToken, desired)
        remainingAmountToAllocate -= toAllocate
        if (toAllocate > 0n) {
          allocations.push({ marketParams: marketData.params, assets: toAllocate })
        }
      } else {
        const toDeallocate = min(
          getWithdrawableAmount(marketData, targetUtilization),
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
