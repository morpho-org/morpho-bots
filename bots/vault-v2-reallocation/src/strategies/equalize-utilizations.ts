import type { Address } from 'viem'

import { MathLib } from '@morpho-org/blue-sdk'
import { isAddressEqual, zeroAddress } from 'viem'

import type { Reallocation, ReallocationAction, Strategy } from './strategy'

import {
  createDepositPools,
  creditPools,
  getDepositableAmount,
  getUtilization,
  getWithdrawableAmount,
  takeFromPools
} from '../math'

type EqualizeUtilizationsConfig = {
  capBufferWad: bigint
  /** Firing threshold: at least one market's utilization must deviate from target by this (bips). */
  minUtilizationDeltaBips: (vault: Address) => number
}

const { min, WAD, wDivDown } = MathLib

/**
 * Converges every market toward the vault-wide average utilization
 * (`sum(totalBorrowAssets) / (sum(totalSupplyAssets) + idleAssets)` — idle counts as deployable
 * supply): deallocates from markets below it, allocates into markets above it. Allocations may
 * exceed deallocations by at most the vault's idle balance (`allocate` pulls from vault balance,
 * so anything beyond that reverts); excess deallocations park in idle. Fires only when at least
 * one market's deviation exceeds the vault's min-delta threshold. Allocations respect the market,
 * adapter-level, and collateral-level caps; capacity freed by this plan's own deallocations
 * (executed first) counts.
 */
export const createEqualizeUtilizationsStrategy = (
  config: EqualizeUtilizationsConfig
): Strategy => {
  return vaultData => {
    const marketsData = vaultData.marketsData.filter(
      marketData => !isAddressEqual(marketData.params.collateralToken, zeroAddress)
    )

    const totalSupply = marketsData.reduce(
      (acc, m) => acc + m.state.totalSupplyAssets,
      vaultData.idleAssets
    )
    const totalBorrow = marketsData.reduce((acc, m) => acc + m.state.totalBorrowAssets, 0n)
    // Nothing supplied or nothing borrowed anywhere — every market already sits at the (degenerate)
    // target, and the per-market target math below would divide by zero.
    if (totalSupply === 0n || totalBorrow === 0n) return undefined
    // Aggregate utilization exceeds 100% in bad-debt states; sizing deallocations toward a >100%
    // target asks for more than the markets hold, so every resulting plan reverts.
    const targetUtilization = min(wDivDown(totalBorrow, totalSupply), WAD)

    // True only if at least one market that actually CONTRIBUTES assets deviates enough — a
    // capped-out or empty market must not arm the trigger for a plan whose real legs are all
    // sub-threshold.
    let didExceedMinUtilizationDelta = false
    const minUtilizationDeltaBips = config.minUtilizationDeltaBips(vaultData.vaultAddress)
    const deviationBips = (utilization: bigint): number =>
      Math.abs(Number((utilization - targetUtilization) / 1_000_000_000n) / 1e5)

    // Deallocations size first (the contract executes them first), crediting the freed capacity to
    // the aggregate cap pools the allocation sizing then draws from. Both the sizing and leg passes
    // walk markets in the same order with the same clamps, so the totals gathered here equal what
    // the leg pass can actually emit.
    let totalAmountToDeallocate = 0n
    const sizingPools = createDepositPools(vaultData, config.capBufferWad)
    for (const marketData of marketsData) {
      const utilization = getUtilization(marketData.state)
      if (utilization > targetUtilization) continue
      const contribution = getWithdrawableAmount(marketData, targetUtilization)
      totalAmountToDeallocate += contribution
      creditPools(sizingPools, marketData.params.collateralToken, contribution)
      if (contribution > 0n) {
        didExceedMinUtilizationDelta ||= deviationBips(utilization) > minUtilizationDeltaBips
      }
    }

    let totalAmountToAllocate = 0n
    for (const marketData of marketsData) {
      const utilization = getUtilization(marketData.state)
      if (utilization <= targetUtilization) continue
      const contribution = takeFromPools(
        sizingPools,
        marketData.params.collateralToken,
        getDepositableAmount(
          marketData,
          vaultData.totalAssets,
          targetUtilization,
          config.capBufferWad
        )
      )
      totalAmountToAllocate += contribution
      if (contribution > 0n) {
        didExceedMinUtilizationDelta ||= deviationBips(utilization) > minUtilizationDeltaBips
      }
    }

    // `allocate` pulls from the vault's asset balance: only this plan's own deallocations plus the
    // existing idle can fund allocations — anything beyond reverts the whole multicall.
    if (totalAmountToAllocate > totalAmountToDeallocate) {
      totalAmountToAllocate =
        totalAmountToDeallocate +
        min(totalAmountToAllocate - totalAmountToDeallocate, vaultData.idleAssets)
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

    const legPools = createDepositPools(vaultData, config.capBufferWad)
    for (const marketData of marketsData) {
      if (remainingAmountToDeallocate === 0n) break
      const utilization = getUtilization(marketData.state)
      if (utilization > targetUtilization) continue
      const toDeallocate = min(
        getWithdrawableAmount(marketData, targetUtilization),
        remainingAmountToDeallocate
      )
      remainingAmountToDeallocate -= toDeallocate
      creditPools(legPools, marketData.params.collateralToken, toDeallocate)
      if (toDeallocate > 0n) {
        deallocations.push({
          marketId: marketData.id,
          marketParams: marketData.params,
          assets: toDeallocate
        })
      }
    }

    for (const marketData of marketsData) {
      if (remainingAmountToAllocate === 0n) break
      const utilization = getUtilization(marketData.state)
      if (utilization <= targetUtilization) continue
      const desired = min(
        getDepositableAmount(
          marketData,
          vaultData.totalAssets,
          targetUtilization,
          config.capBufferWad
        ),
        remainingAmountToAllocate
      )
      const toAllocate = takeFromPools(legPools, marketData.params.collateralToken, desired)
      remainingAmountToAllocate -= toAllocate
      if (toAllocate > 0n) {
        allocations.push({
          marketId: marketData.id,
          marketParams: marketData.params,
          assets: toAllocate
        })
      }
    }

    return { allocations, deallocations } satisfies Reallocation
  }
}
