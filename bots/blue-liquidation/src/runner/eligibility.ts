import type { PlanInput } from '../sizing/plan'
import type { LensOut } from '../state/lens.sol'

/**
 * Off-chain liquidatability, composed from a fresh lens reading. Blue liquidation is permissionless
 * and time-independent, so the gate is simply `debt > 0 && unhealthy`, plus the on-chain `valid`
 * check the lens already performed (the market exists at `keccak256(abi.encode(params))`).
 */
export function isLiquidatable(out: LensOut): boolean {
  return out.valid && out.hasDebt && !out.healthy
}

/**
 * Maps a fresh {@link LensOut} into the sizing {@link PlanInput}. Everything is the flat per-position
 * and accrued-market state the lens read in the same `eth_call`; `lltv` and `collateralPrice` come
 * from that reading too.
 */
export function planInputFromLens(out: LensOut): PlanInput {
  return {
    hasDebt: out.hasDebt,
    healthy: out.healthy,
    borrowShares: out.borrowShares,
    collateral: out.collateral,
    accruedTotalBorrowAssets: out.accruedTotalBorrowAssets,
    totalBorrowShares: out.totalBorrowShares,
    collateralPrice: out.collateralPrice,
    lltv: out.lltv
  }
}
