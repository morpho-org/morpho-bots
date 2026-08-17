import type { Address, Hex } from 'viem'

import { MathLib } from '@morpho-org/blue-sdk'
import { maxUint256 } from 'viem'

import type { VaultMarketData } from '../vault-data'
import type { MarketAllocation, Strategy } from './strategy'

import { isIdleMarket } from '../market.utils'
import {
  apyToRate,
  getDepositableAmount,
  getUtilization,
  getWithdrawableAmount,
  percentToWad,
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

/** Where a market's utilization sits relative to the utilization bounds its APY range implies. */
const classifyMarket = (
  config: ApyRangeConfig,
  vault: Address,
  marketData: VaultMarketData
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
 * Keeps each non-idle market's borrow APY inside its configured range: converts the APY bounds to
 * utilization bounds via the AdaptiveCurveIRM inverse, withdraws from markets below range, deposits
 * into markets above range, and lets the idle market absorb or supply the imbalance.
 *
 * Only markets on the canonical AdaptiveCurveIRM participate — the inversion is meaningless without
 * a real `rateAtTarget`, so a foreign-IRM market is excluded from both legs rather than misread (see
 * `isAdaptiveCurve` on {@link VaultMarketData}).
 */
export const createApyRangeStrategy = (config: ApyRangeConfig): Strategy => {
  return vaultData => {
    const vault = vaultData.vaultAddress
    const idleMarket = vaultData.marketsData.find(isIdleMarket)
    const marketsData = vaultData.marketsData.filter(
      marketData => !isIdleMarket(marketData) && marketData.isAdaptiveCurve
    )

    let totalWithdrawableAmount = 0n
    let totalDepositableAmount = 0n

    let didExceedMinApyDelta = false // true if *at least one contributing* market moves enough

    for (const marketData of marketsData) {
      const { utilization, lowerBound, upperBound } = classifyMarket(config, vault, marketData)

      if (utilization > upperBound) {
        const depositable = getDepositableAmount(marketData, upperBound, config.capBufferPercent)
        totalDepositableAmount += depositable
        if (depositable > 0n) {
          didExceedMinApyDelta ||=
            apyDeltaBips(utilization, upperBound, marketData.rateAtTarget) >
            config.minApyDeltaBips(vault, marketData.id)
        }
      } else if (utilization < lowerBound) {
        const withdrawable = getWithdrawableAmount(marketData, lowerBound)
        totalWithdrawableAmount += withdrawable
        if (withdrawable > 0n) {
          didExceedMinApyDelta ||=
            apyDeltaBips(utilization, lowerBound, marketData.rateAtTarget) >
            config.minApyDeltaBips(vault, marketData.id)
        }
      }
    }

    let idleWithdrawal = 0n
    let idleDeposit = 0n

    if (idleMarket) {
      if (totalWithdrawableAmount > totalDepositableAmount && config.allowIdleReallocation) {
        // Same clamped-headroom treatment every other deposit target gets: a curator can lower a cap
        // below the current allocation, and an unclamped `cap - vaultAssets` would go negative and
        // corrupt the plan.
        const bufferedIdleCap = MathLib.wMulDown(
          idleMarket.cap,
          percentToWad(config.capBufferPercent)
        )
        const idleHeadroom =
          bufferedIdleCap > idleMarket.vaultAssets ? bufferedIdleCap - idleMarket.vaultAssets : 0n
        idleDeposit = min(totalWithdrawableAmount - totalDepositableAmount, idleHeadroom)
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
      const { utilization, lowerBound, upperBound } = classifyMarket(config, vault, marketData)

      if (utilization > upperBound) {
        const deposit = min(
          getDepositableAmount(marketData, upperBound, config.capBufferPercent),
          remainingDeposit
        )
        if (deposit === 0n) continue
        remainingDeposit -= deposit
        deposits.push({
          marketParams: marketData.params,
          assets: remainingDeposit === 0n ? maxUint256 : marketData.vaultAssets + deposit
        })
      } else if (utilization < lowerBound) {
        const withdrawal = min(getWithdrawableAmount(marketData, lowerBound), remainingWithdrawal)
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
