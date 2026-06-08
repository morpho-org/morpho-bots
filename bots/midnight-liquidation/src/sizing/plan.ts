import { ORACLE_PRICE_SCALE, WAD } from '../constants'
import { lifAt } from './lif'
import { mulDivUp } from './math'
import { isRcfExempt, maxRepaidPreMaturity } from './rcf'

/**
 * The fresh, lens-derived inputs the sizing decision depends on. Field names mirror the lens
 * output; `blockTimestamp` is chain time (not host clock), so LIF and the `now > maturity` test
 * are evaluated against the same block the rest of the reading came from.
 */
export type PlanInput = {
  blockTimestamp: bigint
  maturity: bigint
  hasDebt: boolean
  locked: boolean
  /** `isHealthy`: `maxDebt >= debt` (so `!healthy` ⟺ `debt > maxDebt`). */
  healthy: boolean
  debt: bigint
  badDebt: bigint
  maxDebt: bigint
  /** Market-level `rcfThreshold`. */
  rcfThreshold: bigint
  /** Best (highest USD value) activated collateral slot, chosen by the lens. */
  bestCollateralIndex: number
  bestCollateralAmt: bigint
  /** Oracle price of the best slot, in ORACLE_PRICE_SCALE units. */
  bestCollateralPrice: bigint
  /** Per-collateral `maxLif` and `lltv` of the best slot. */
  bestCollateralMaxLif: bigint
  bestCollateralLltv: bigint
}

export type LiquidationPlan = {
  collateralIndex: number
  seizedAssets: bigint
  repaidUnits: bigint
  postMaturityMode: boolean
}

// Repaid units the contract derives when the caller passes `seizedAssets` (midnight-contracts.txt:2369):
// two chained ceil-divisions, collateral → loan units → repaid units.
function impliedRepaidUnits(seizedAssets: bigint, price: bigint, lif: bigint): bigint {
  return mulDivUp(mulDivUp(seizedAssets, price, ORACLE_PRICE_SCALE), WAD, lif)
}

/**
 * Turns a fresh lens reading into a liquidation plan, or `null` when the position is not
 * liquidatable. Mirrors the mode and amount policy of `liquidate(...)`:
 *
 * - past maturity → post-maturity mode: seize 100% of the best slot at the ramped LIF, no RCF cap;
 * - pre-maturity & unhealthy → normal mode: seize 100% of the slot if that stays within the RCF
 *   cap (or the slot is rcf-exempt), otherwise repay exactly `maxRepaid`;
 * - otherwise (no debt, locked, or healthy-and-pre-maturity) → skip.
 *
 * The plan emits exactly one nonzero amount (`atMostOneNonZero`, :2314); the contract derives the
 * other side. An over-large `repaidUnits` fails closed in `simulate()`, never on-chain.
 */
export function plan(input: PlanInput): LiquidationPlan | null {
  if (!input.hasDebt || input.locked) return null

  const postMaturityMode = input.blockTimestamp > input.maturity
  if (!postMaturityMode && input.healthy) return null

  const lif = lifAt({
    now: input.blockTimestamp,
    maturity: input.maturity,
    maxLif: input.bestCollateralMaxLif,
    postMaturityMode
  })

  const seizeWholeSlot: LiquidationPlan = {
    collateralIndex: input.bestCollateralIndex,
    seizedAssets: input.bestCollateralAmt,
    repaidUnits: 0n,
    postMaturityMode
  }

  // Post-maturity mode takes the whole slot with no cap.
  if (postMaturityMode) return seizeWholeSlot

  // Normal mode: the RCF cap binds unless seizing the whole slot stays within `maxRepaid`, or the
  // slot is rcf-exempt.
  const maxRepaid = maxRepaidPreMaturity({
    debt: input.debt,
    badDebt: input.badDebt,
    maxDebt: input.maxDebt,
    lif,
    lltv: input.bestCollateralLltv
  })
  const wholeSlotRepaid = impliedRepaidUnits(
    input.bestCollateralAmt,
    input.bestCollateralPrice,
    lif
  )
  const capBinds = wholeSlotRepaid > maxRepaid
  const exempt = isRcfExempt({
    collateralAmt: input.bestCollateralAmt,
    price: input.bestCollateralPrice,
    lif,
    maxRepaid,
    rcfThreshold: input.rcfThreshold
  })

  if (!capBinds || exempt) return seizeWholeSlot
  return {
    collateralIndex: input.bestCollateralIndex,
    seizedAssets: 0n,
    repaidUnits: maxRepaid,
    postMaturityMode
  }
}
