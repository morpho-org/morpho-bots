import type { Address } from 'viem'

import { MathLib } from '@morpho-org/blue-sdk'
import { maxUint256, zeroAddress } from 'viem'

import type { MarketAllocation, Strategy } from './strategy'

import { getDepositableAmount, getUtilization, getWithdrawableAmount } from '../math'

export type EqualizeUtilizationsConfig = {
  capBufferPercent: number
  /** Firing threshold: at least one market's utilization must deviate from target by this (bips). */
  minUtilizationDeltaBips: (vault: Address) => number
}

const { min, wDivDown } = MathLib

/**
 * Converges every non-idle market toward the vault-wide average utilization
 * (`sum(totalBorrowAssets) / sum(totalSupplyAssets)`): withdraws from markets below it, deposits
 * into markets above it. The idle market is excluded entirely. Fires only when at least one
 * market's deviation exceeds the vault's min-delta threshold.
 */
export const createEqualizeUtilizationsStrategy = (
  config: EqualizeUtilizationsConfig
): Strategy => {
  return vaultData => {
    const marketsData = vaultData.marketsData.filter(
      marketData => marketData.params.collateralToken !== zeroAddress
    )

    const totalSupply = marketsData.reduce((acc, m) => acc + m.state.totalSupplyAssets, 0n)
    const totalBorrow = marketsData.reduce((acc, m) => acc + m.state.totalBorrowAssets, 0n)
    // Nothing supplied or nothing borrowed anywhere — every market already sits at the (degenerate)
    // target, and the per-market target math below would divide by zero.
    if (totalSupply === 0n || totalBorrow === 0n) return
    const targetUtilization = wDivDown(totalBorrow, totalSupply)

    let totalWithdrawableAmount = 0n
    let totalDepositableAmount = 0n

    let didExceedMinUtilizationDelta = false // true if *at least one* market moves enough
    const minUtilizationDeltaBips = config.minUtilizationDeltaBips(vaultData.vaultAddress)

    for (const marketData of marketsData) {
      const utilization = getUtilization(marketData.state)
      if (utilization > targetUtilization) {
        totalDepositableAmount += getDepositableAmount(
          marketData,
          targetUtilization,
          config.capBufferPercent
        )
      } else {
        totalWithdrawableAmount += getWithdrawableAmount(marketData, targetUtilization)
      }

      didExceedMinUtilizationDelta ||=
        Math.abs(Number((utilization - targetUtilization) / 1_000_000_000n) / 1e5) >
        minUtilizationDeltaBips
    }

    const toReallocate = min(totalWithdrawableAmount, totalDepositableAmount)
    if (toReallocate === 0n || !didExceedMinUtilizationDelta) return

    let remainingWithdrawal = toReallocate
    let remainingDeposit = toReallocate

    const withdrawals: MarketAllocation[] = []
    const deposits: MarketAllocation[] = []

    for (const marketData of marketsData) {
      const utilization = getUtilization(marketData.state)

      if (utilization > targetUtilization) {
        const deposit = min(
          getDepositableAmount(marketData, targetUtilization, config.capBufferPercent),
          remainingDeposit
        )
        remainingDeposit -= deposit
        deposits.push({
          marketParams: marketData.params,
          assets: remainingDeposit === 0n ? maxUint256 : marketData.vaultAssets + deposit
        })
      } else {
        const withdrawal = min(
          getWithdrawableAmount(marketData, targetUtilization),
          remainingWithdrawal
        )
        remainingWithdrawal -= withdrawal
        withdrawals.push({
          marketParams: marketData.params,
          assets: marketData.vaultAssets - withdrawal
        })
      }

      if (remainingWithdrawal === 0n && remainingDeposit === 0n) break
    }

    return [...withdrawals, ...deposits]
  }
}
