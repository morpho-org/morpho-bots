import type { Address, Hex } from 'viem'

import { MathLib } from '@morpho-org/blue-sdk'

import type { VaultV2MarketData } from '../vault-data'
import type { Reallocation, ReallocationAction, Strategy } from './strategy'

import {
  apyToRate,
  createDepositPools,
  creditPools,
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

/** Where a market's utilization sits relative to the utilization bounds its APY range implies. */
const classifyMarket = (
  config: ApyRangeConfig,
  vault: Address,
  marketData: VaultV2MarketData
): { utilization: bigint; lowerBound: bigint; upperBound: bigint } => {
  const apyRange = config.apyRange(vault, marketData.id)
  return {
    utilization: getUtilization(marketData.state),
    lowerBound: rateToUtilization(apyToRate(apyRange.min), marketData.rateAtTarget),
    upperBound: rateToUtilization(apyToRate(apyRange.max), marketData.rateAtTarget)
  }
}

const apyDeltaBips = (from: bigint, to: bigint, rateAtTarget: bigint): number =>
  Math.abs(
    Number(
      (rateToApy(utilizationToRate(to, rateAtTarget)) -
        rateToApy(utilizationToRate(from, rateAtTarget))) /
        1_000_000_000n
    ) / 1e5
  )

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
 * collateral-level caps; capacity freed by this plan's own deallocations (executed first) counts.
 */
export const createApyRangeStrategy = (config: ApyRangeConfig): Strategy => {
  return vaultData => {
    const vault = vaultData.vaultAddress
    const marketsData = vaultData.marketsData.filter(marketData => marketData.isAdaptiveCurve)

    // True only if at least one market that actually CONTRIBUTES assets moves enough — a capped-out
    // or empty market must not arm the trigger for a plan whose real legs are all sub-threshold.
    let didExceedMinApyDelta = false

    // Deallocations size first (the contract executes them first), crediting the freed capacity to
    // the aggregate cap pools the allocation sizing then draws from. Both the sizing and leg passes
    // walk markets in the same order with the same clamps, so the totals gathered here equal what
    // the leg pass can actually emit.
    let totalAmountToDeallocate = 0n
    const sizingPools = createDepositPools(vaultData, config.capBufferPercent)
    for (const marketData of marketsData) {
      const { utilization, lowerBound } = classifyMarket(config, vault, marketData)
      if (utilization >= lowerBound) continue
      const contribution = getWithdrawableAmount(marketData, lowerBound)
      totalAmountToDeallocate += contribution
      creditPools(sizingPools, marketData.params.collateralToken, contribution)
      if (contribution > 0n) {
        didExceedMinApyDelta ||=
          apyDeltaBips(utilization, lowerBound, marketData.rateAtTarget) >
          config.minApyDeltaBips(vault, marketData.id)
      }
    }

    let totalAmountToAllocate = 0n
    for (const marketData of marketsData) {
      const { utilization, upperBound } = classifyMarket(config, vault, marketData)
      if (utilization <= upperBound) continue
      const contribution = takeFromPools(
        sizingPools,
        marketData.params.collateralToken,
        getDepositableAmount(marketData, vaultData.totalAssets, upperBound, config.capBufferPercent)
      )
      totalAmountToAllocate += contribution
      if (contribution > 0n) {
        didExceedMinApyDelta ||=
          apyDeltaBips(utilization, upperBound, marketData.rateAtTarget) >
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
      if (remainingAmountToDeallocate === 0n) break
      const { utilization, lowerBound } = classifyMarket(config, vault, marketData)
      if (utilization >= lowerBound) continue
      const toDeallocate = min(
        getWithdrawableAmount(marketData, lowerBound),
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
      const { utilization, upperBound } = classifyMarket(config, vault, marketData)
      if (utilization <= upperBound) continue
      const desired = min(
        getDepositableAmount(
          marketData,
          vaultData.totalAssets,
          upperBound,
          config.capBufferPercent
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
