import type { Address, Hex } from 'viem'

import type { Strategy } from './strategy'

import {
  apyToRate,
  getUtilization,
  rateToApy,
  rateToUtilization,
  utilizationToRate,
  wadToBips
} from '../math'
import { createReconciler } from './reconcile'

export type ApyRangeConfig = {
  /** Whether excess withdrawals may be parked in the vault's idle market. */
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
 * Keeps each non-idle market's borrow APY inside its configured range: converts the APY bounds to
 * utilization bounds via the AdaptiveCurveIRM inverse, so a market above range targets its upper
 * bound (a deposit) and one below range targets its lower bound (a withdrawal), and lets the idle
 * market absorb or supply the imbalance.
 *
 * Only markets on the canonical AdaptiveCurveIRM participate — the inversion is meaningless without
 * a real `rateAtTarget`, so a foreign-IRM market is excluded from both legs rather than misread (see
 * `isAdaptiveCurve` on `VaultMarketData`).
 */
export const createApyRangeStrategy = (config: ApyRangeConfig): Strategy =>
  createReconciler({
    allowIdleReallocation: config.allowIdleReallocation,
    capBufferWad: config.capBufferWad,
    idle: 'net',
    classifierFor:
      ({ vaultAddress }) =>
      marketData => {
        if (!marketData.isAdaptiveCurve) return undefined

        const { rateAtTarget } = marketData
        const apyRange = config.apyRange(vaultAddress, marketData.id)
        const utilization = getUtilization(marketData.state)
        const lowerBound = rateToUtilization(apyToRate(apyRange.min), rateAtTarget)
        const upperBound = rateToUtilization(apyToRate(apyRange.max), rateAtTarget)

        let bound: bigint | undefined
        if (utilization > upperBound) bound = upperBound
        else if (utilization < lowerBound) bound = lowerBound
        if (bound === undefined) return undefined

        return {
          targetUtilization: bound,
          clearsMinDelta:
            apyDeltaBips(utilization, bound, rateAtTarget) >
            config.minApyDeltaBips(vaultAddress, marketData.id)
        }
      }
  })
