import type { Address } from 'viem'

import { MathLib } from '@morpho-org/blue-sdk'

import type { Strategy } from './strategy'

import { isIdleMarket } from '../market.utils'
import { getUtilization } from '../math'
import { createReconciler } from './reconcile'

type EqualizeUtilizationsConfig = {
  /** WAD-scaled cap scale factor (e.g. 99.99% as 0.9999e18). */
  capBufferWad: bigint
  /** Firing threshold: at least one market's utilization must deviate from target by this (bips). */
  minUtilizationDeltaBips: (vault: Address) => number
}

const { min, WAD, wDivDown } = MathLib

/**
 * Converges every non-idle market toward the vault-wide average utilization
 * (`sum(totalBorrowAssets) / sum(totalSupplyAssets)`, clamped at 100%): withdraws from markets below
 * it, deposits into markets above it. The idle market is excluded entirely. Fires only when at least
 * one market's deviation exceeds the vault's min-delta threshold. Utilization-only, so markets on any
 * IRM participate.
 */
export const createEqualizeUtilizationsStrategy = (config: EqualizeUtilizationsConfig): Strategy =>
  createReconciler({
    capBufferWad: config.capBufferWad,
    idle: 'ignore',
    classifierFor: vaultData => {
      const marketsData = vaultData.marketsData.filter(marketData => !isIdleMarket(marketData))
      const totalSupply = marketsData.reduce((acc, m) => acc + m.state.totalSupplyAssets, 0n)
      const totalBorrow = marketsData.reduce((acc, m) => acc + m.state.totalBorrowAssets, 0n)
      // Nothing supplied or nothing borrowed anywhere — every market already sits at the (degenerate)
      // target, and the per-market target math below would divide by zero.
      if (totalSupply === 0n || totalBorrow === 0n) return () => undefined

      const minUtilizationDeltaBips = config.minUtilizationDeltaBips(vaultData.vaultAddress)
      // Aggregate utilization exceeds 100% in bad-debt states; sizing withdrawals toward a >100% target
      // asks for more than the markets hold, so every resulting plan reverts.
      const targetUtilization = min(wDivDown(totalBorrow, totalSupply), WAD)

      return marketData => ({
        targetUtilization,
        clearsMinDelta:
          Math.abs(
            Number((getUtilization(marketData.state) - targetUtilization) / 1_000_000_000n) / 1e5
          ) > minUtilizationDeltaBips
      })
    }
  })
