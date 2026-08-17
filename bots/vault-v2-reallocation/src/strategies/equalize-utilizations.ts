import type { Address } from 'viem'

import { MathLib } from '@morpho-org/blue-sdk'
import { isAddressEqual, zeroAddress } from 'viem'

import type { VaultV2MarketData } from '../vault-data'
import type { Strategy } from './strategy'

import { getUtilization } from '../math'
import { createReconciler } from './reconcile'

type EqualizeUtilizationsConfig = {
  /** WAD-scaled cap scale factor (e.g. 99.99% as 0.9999e18). */
  capBufferWad: bigint
  /** Firing threshold: at least one market's utilization must deviate from target by this (bips). */
  minUtilizationDeltaBips: (vault: Address) => number
}

const { min, WAD, wDivDown } = MathLib

const isRealCollateral = (marketData: VaultV2MarketData): boolean =>
  !isAddressEqual(marketData.params.collateralToken, zeroAddress)

/**
 * Converges every market toward the vault-wide average utilization
 * (`sum(totalBorrowAssets) / (sum(totalSupplyAssets) + idleAssets)`, clamped at 100% — idle counts
 * as deployable supply): deallocates from markets below it, allocates into markets above it, with
 * the imbalance netted through the vault's idle balance (excess deallocations always park there).
 * Fires only when at least one contributing market's deviation exceeds the vault's min-delta
 * threshold. Utilization-only, so markets on any IRM participate.
 */
export const createEqualizeUtilizationsStrategy = (config: EqualizeUtilizationsConfig): Strategy =>
  createReconciler({
    capBufferWad: config.capBufferWad,
    allowIdleParking: true,
    classifierFor: vaultData => {
      const marketsData = vaultData.marketsData.filter(isRealCollateral)
      const totalSupply = marketsData.reduce(
        (acc, m) => acc + m.state.totalSupplyAssets,
        vaultData.idleAssets
      )
      const totalBorrow = marketsData.reduce((acc, m) => acc + m.state.totalBorrowAssets, 0n)
      // Nothing supplied or nothing borrowed anywhere — every market already sits at the
      // (degenerate) target, and the per-market target math below would divide by zero.
      if (totalSupply === 0n || totalBorrow === 0n) return () => undefined

      const minUtilizationDeltaBips = config.minUtilizationDeltaBips(vaultData.vaultAddress)
      // Aggregate utilization exceeds 100% in bad-debt states; sizing deallocations toward a >100%
      // target asks for more than the markets hold, so every resulting plan reverts.
      const targetUtilization = min(wDivDown(totalBorrow, totalSupply), WAD)

      return marketData => {
        if (!isRealCollateral(marketData)) return undefined
        return {
          targetUtilization,
          clearsMinDelta:
            Math.abs(
              Number((getUtilization(marketData.state) - targetUtilization) / 1_000_000_000n) / 1e5
            ) > minUtilizationDeltaBips
        }
      }
    }
  })
