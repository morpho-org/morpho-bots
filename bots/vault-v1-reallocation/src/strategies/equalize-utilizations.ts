import type { Address } from 'viem'

import { MathLib } from '@morpho-org/blue-sdk'

import type { Strategy } from './strategy'

import { getUtilization, MAX_TARGET_UTILIZATION, wadToBips } from '../math'
import { createReconciler } from './reconcile'

type EqualizeUtilizationsConfig = {
  /** WAD-scaled cap scale factor (e.g. 99.99% as 0.9999e18). */
  capBufferWad: bigint
  /** Firing threshold: at least one market's utilization must deviate from target by this (bips). */
  minUtilizationDeltaBips: (vault: Address) => number
}

const { min, wDivDown } = MathLib

/**
 * Converges every non-idle market toward the vault-wide average utilization
 * (`sum(totalBorrowAssets) / sum(totalSupplyAssets)`): withdraws from markets below it, deposits into
 * markets above it. The idle market is excluded entirely. Fires only when at least one market's
 * deviation exceeds the vault's min-delta threshold. Utilization-only, so markets on any IRM
 * participate.
 *
 * The aggregate exceeds 100% in bad-debt states, so the target markets are actually sized against is
 * capped at {@link MAX_TARGET_UTILIZATION}; the side each market moves is still decided on the raw
 * aggregate, and a market the cap leaves at-or-past its target gets no leg.
 */
export const createEqualizeUtilizationsStrategy = (config: EqualizeUtilizationsConfig): Strategy =>
  createReconciler({
    capBufferWad: config.capBufferWad,
    idle: 'ignore',
    classifierFor: vaultData => {
      const marketsData = vaultData.marketsData.filter(marketData => !marketData.isIdle)
      const totalSupply = marketsData.reduce((acc, m) => acc + m.state.totalSupplyAssets, 0n)
      const totalBorrow = marketsData.reduce((acc, m) => acc + m.state.totalBorrowAssets, 0n)
      // Nothing supplied or nothing borrowed anywhere — every market already sits at the (degenerate)
      // target, and the per-market target math below would divide by zero.
      if (totalSupply === 0n || totalBorrow === 0n) return () => undefined

      const minUtilizationDeltaBips = config.minUtilizationDeltaBips(vaultData.vaultAddress)
      const rawTarget = wDivDown(totalBorrow, totalSupply)
      const targetUtilization = min(rawTarget, MAX_TARGET_UTILIZATION)

      return marketData => {
        const utilization = getUtilization(marketData.state)
        return {
          targetUtilization,
          intent: utilization > rawTarget ? 'deposit' : 'withdraw',
          clearsMinDelta: utilizationAfter =>
            Math.abs(wadToBips(utilization - utilizationAfter)) > minUtilizationDeltaBips
        }
      }
    }
  })
