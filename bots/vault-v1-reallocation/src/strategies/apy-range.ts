import type { Address, Hex } from 'viem'

import { MathLib } from '@morpho-org/blue-sdk'
import { maxUint256, zeroAddress } from 'viem'

import type { MarketAllocation, Strategy } from './strategy'

import {
  apyToRate,
  getDepositableAmount,
  getUtilization,
  getWithdrawableAmount,
  rateToApy,
  rateToUtilization,
  utilizationToRate
} from '../math'

export type ApyRangeConfig = {
  /** Whether excess withdrawals may be parked in the vault's idle market. */
  allowIdleReallocation: boolean
  capBufferPercent: number
  /** WAD-scaled borrow-APY bounds for (vault, market). */
  apyRange: (vault: Address, marketId: Hex) => { min: bigint; max: bigint }
  /** Firing threshold: at least one market's implied APY move must exceed this (bips). */
  minApyDeltaBips: (vault: Address, marketId: Hex) => number
}

const { min } = MathLib

/**
 * Keeps each non-idle market's borrow APY inside its configured range: converts the APY bounds to
 * utilization bounds via the AdaptiveCurveIRM inverse, withdraws from markets below range, deposits
 * into markets above range, and lets the idle market absorb or supply the imbalance. Assumes every
 * non-idle market uses the AdaptiveCurveIRM (its `rateAtTarget` drives the inversion).
 */
export const createApyRangeStrategy = (config: ApyRangeConfig): Strategy => {
  return vaultData => {
    const vault = vaultData.vaultAddress
    const idleMarket = vaultData.marketsData.find(
      marketData => marketData.params.collateralToken === zeroAddress
    )
    const marketsData = vaultData.marketsData.filter(
      marketData => marketData.params.collateralToken !== zeroAddress
    )

    let totalWithdrawableAmount = 0n
    let totalDepositableAmount = 0n

    let didExceedMinApyDelta = false // true if *at least one* market moves enough

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
        totalDepositableAmount += getDepositableAmount(
          marketData,
          upperUtilizationBound,
          config.capBufferPercent
        )
        const apyDelta =
          rateToApy(utilizationToRate(upperUtilizationBound, marketData.rateAtTarget)) -
          rateToApy(utilizationToRate(utilization, marketData.rateAtTarget))
        didExceedMinApyDelta ||=
          Math.abs(Number(apyDelta / 1_000_000_000n) / 1e5) >
          config.minApyDeltaBips(vault, marketData.id)
      } else if (utilization < lowerUtilizationBound) {
        totalWithdrawableAmount += getWithdrawableAmount(marketData, lowerUtilizationBound)
        const apyDelta =
          rateToApy(utilizationToRate(lowerUtilizationBound, marketData.rateAtTarget)) -
          rateToApy(utilizationToRate(utilization, marketData.rateAtTarget))
        didExceedMinApyDelta ||=
          Math.abs(Number(apyDelta / 1_000_000_000n) / 1e5) >
          config.minApyDeltaBips(vault, marketData.id)
      }
    }

    let idleWithdrawal = 0n
    let idleDeposit = 0n

    if (idleMarket) {
      if (totalWithdrawableAmount > totalDepositableAmount && config.allowIdleReallocation) {
        idleDeposit = min(
          totalWithdrawableAmount - totalDepositableAmount,
          idleMarket.cap - idleMarket.vaultAssets
        )
        totalDepositableAmount += idleDeposit
      } else if (totalDepositableAmount > totalWithdrawableAmount) {
        idleWithdrawal = min(
          totalDepositableAmount - totalWithdrawableAmount,
          idleMarket.vaultAssets
        )
        totalWithdrawableAmount += idleWithdrawal
      }
    }

    const toReallocate = min(totalWithdrawableAmount, totalDepositableAmount)
    if (toReallocate === 0n || !didExceedMinApyDelta) return undefined

    let remainingWithdrawal = toReallocate
    let remainingDeposit = toReallocate

    const withdrawals: MarketAllocation[] = []
    const deposits: MarketAllocation[] = []

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
        const deposit = min(
          getDepositableAmount(marketData, upperUtilizationBound, config.capBufferPercent),
          remainingDeposit
        )
        if (deposit === 0n) continue
        remainingDeposit -= deposit
        deposits.push({
          marketParams: marketData.params,
          assets: remainingDeposit === 0n ? maxUint256 : marketData.vaultAssets + deposit
        })
      } else if (utilization < lowerUtilizationBound) {
        const withdrawal = min(
          getWithdrawableAmount(marketData, lowerUtilizationBound),
          remainingWithdrawal
        )
        if (withdrawal === 0n) continue
        remainingWithdrawal -= withdrawal
        withdrawals.push({
          marketParams: marketData.params,
          assets: marketData.vaultAssets - withdrawal
        })
      }

      if (remainingWithdrawal === 0n && remainingDeposit === 0n) break
    }

    if (idleMarket) {
      if (idleWithdrawal > 0n) {
        withdrawals.push({
          marketParams: idleMarket.params,
          assets: idleMarket.vaultAssets - idleWithdrawal
        })
      }
      if (idleDeposit > 0n && config.allowIdleReallocation) {
        deposits.push({ marketParams: idleMarket.params, assets: maxUint256 })
      }
    }

    return [...withdrawals, ...deposits]
  }
}
