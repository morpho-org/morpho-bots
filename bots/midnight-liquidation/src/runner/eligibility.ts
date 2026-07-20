import type { PlanInput } from '../sizing/plan';
import type { LensOut } from '../state/lens.sol';

/**
 * Off-chain liquidatability, composed from a fresh lens reading — mirrors the gate `liquidate()`
 * enforces: `debt > 0 && !locked && (now > maturity || unhealthy)`, AND the per-element checks the
 * lens already performed on-chain (`valid` = the market exists; `gateAllows` = the liquidator
 * gate admits the Executor). `now` is the lens's `blockTimestamp` (chain time, not host clock).
 */
export function isLiquidatable(out: LensOut): boolean {
  return (
    out.valid &&
    out.gateAllows &&
    out.hasDebt &&
    !out.locked &&
    (out.blockTimestamp > out.market.maturity || !out.healthy)
  );
}

/**
 * Maps a fresh {@link LensOut} into the sizing {@link PlanInput}. The market-config fields
 * (`maturity`, `rcfThreshold`) come from the returned `market`; everything else is the flat
 * per-position state the lens read in the same `eth_call`.
 */
export function planInputFromLens(out: LensOut): PlanInput {
  return {
    blockTimestamp: out.blockTimestamp,
    maturity: out.market.maturity,
    hasDebt: out.hasDebt,
    locked: out.locked,
    healthy: out.healthy,
    debt: out.debt,
    badDebt: out.badDebt,
    maxDebt: out.maxDebt,
    rcfThreshold: out.market.rcfThreshold,
    bestCollateralIndex: out.bestCollateralIdx,
    bestCollateralAmt: out.bestCollateralAmt,
    bestCollateralPrice: out.bestCollateralPrice,
    bestCollateralMaxLif: out.bestCollateralMaxLif,
    bestCollateralLltv: out.bestCollateralLltv
  };
}
