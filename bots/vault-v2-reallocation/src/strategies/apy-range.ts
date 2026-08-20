import type { Address, Hex } from 'viem'

import type { Strategy } from './strategy'

import {
  apyToRate,
  getUtilization,
  MAX_TARGET_UTILIZATION,
  rateToApy,
  rateToUtilization,
  utilizationToRate,
  wadToBips
} from '../math'
import { createReconciler } from './reconcile'

export type ApyRangeConfig = {
  /** Whether excess deallocations may be parked in the vault's idle balance. */
  allowIdleReallocation: boolean
  /** WAD-scaled cap scale factor (e.g. 99.99% as 0.9999e18). */
  capBufferWad: bigint
  /** WAD-scaled borrow-APY bounds for (vault, market). */
  apyRange: (vault: Address, marketId: Hex) => { min: bigint; max: bigint }
  /** Firing threshold: at least one market's implied APY move must exceed this (bips). */
  minApyDeltaBips: (vault: Address, marketId: Hex) => number
}

const apyDeltaBips = (from: bigint, to: bigint, rateAtTarget: bigint): number =>
  Math.abs(
    wadToBips(
      rateToApy(utilizationToRate(to, rateAtTarget)) -
        rateToApy(utilizationToRate(from, rateAtTarget))
    )
  )

/**
 * Keeps each market's borrow APY inside its configured range: converts the APY bounds to
 * utilization bounds via the AdaptiveCurveIRM inverse, so a market above range targets its upper
 * bound (an allocation) and one below range targets its lower bound (a deallocation), with the
 * imbalance netted through the vault's idle balance.
 *
 * Only markets on the canonical AdaptiveCurveIRM participate — the inversion is meaningless without
 * a real `rateAtTarget`, so a foreign-IRM market is excluded from both legs rather than misread
 * (see `isAdaptiveCurve` on the market data).
 */
export const createApyRangeStrategy = (config: ApyRangeConfig): Strategy =>
  createReconciler({
    capBufferWad: config.capBufferWad,
    allowIdleParking: config.allowIdleReallocation,
    classifierFor:
      ({ vaultAddress }) =>
      marketData => {
        if (!marketData.isAdaptiveCurve) return undefined

        const { rateAtTarget } = marketData
        const apyRange = config.apyRange(vaultAddress, marketData.id)
        const utilization = getUtilization(marketData.state)
        const lowerBound = rateToUtilization(apyToRate(apyRange.min), rateAtTarget)
        const upperBound = rateToUtilization(apyToRate(apyRange.max), rateAtTarget)

        const boundFor = (u: bigint): bigint | undefined => {
          if (u > upperBound) return upperBound
          if (u < lowerBound) return lowerBound
          return undefined
        }
        const bound = boundFor(utilization)
        if (bound === undefined) return undefined
        // The leg only travels to the clamped bound, so the firing gate measures that realizable
        // move — while the side stays decided by the raw bound (see MarketTarget.intent).
        const targetUtilization = bound > MAX_TARGET_UTILIZATION ? MAX_TARGET_UTILIZATION : bound

        return {
          targetUtilization,
          intent: utilization > bound ? 'allocate' : 'deallocate',
          clearsMinDelta: utilizationAfter =>
            apyDeltaBips(utilization, utilizationAfter, rateAtTarget) >
            config.minApyDeltaBips(vaultAddress, marketData.id)
        }
      }
  })
