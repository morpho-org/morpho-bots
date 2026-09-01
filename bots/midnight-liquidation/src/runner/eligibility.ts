import { isAddressEqual } from 'viem'

import type { CollateralSlot, PlanInput } from '../sizing/plan'
import type { LensOut } from '../state/lens.sol'

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
  )
}

/**
 * Maps a fresh {@link LensOut} into the sizing {@link PlanInput}. The market-config fields
 * (`maturity`, `rcfThreshold`) come from the returned `market`; everything else is the flat
 * per-position state the lens read in the same `eth_call`.
 *
 * This is also where `swapFree` is decided, and it is the only place that can be: the sizing layer
 * holds no token addresses, and the lens cannot compare a slot's token to the loan token without
 * duplicating market state it already returns. A slot whose token IS the loan token needs no swap to
 * fund its repay, which changes both its cost model and its execution risk — see
 * {@link CollateralSlot.swapFree}.
 */
export function planInputFromLens(out: LensOut): PlanInput {
  const collaterals: CollateralSlot[] = out.collaterals.map(slot => ({
    index: slot.index,
    amt: slot.amt,
    price: slot.price,
    maxLif: slot.maxLif,
    lltv: slot.lltv,
    swapFree: isSwapFreeSlot(out, slot.index)
  }))
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
    collaterals
  }
}

// Whether a market-level collateral index addresses the market's own loan token. A slot index the
// market does not define cannot be swap-free — the lens only emits indices `toMarket(id)` returned, so
// this is unreachable defensiveness rather than an expected branch.
const isSwapFreeSlot = (out: LensOut, index: number): boolean => {
  const token = out.market.collateralParams[index]?.token
  return token !== undefined && isAddressEqual(token, out.market.loanToken)
}
