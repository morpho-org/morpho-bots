// Pure edge-sizing math for the position-seeding script. Inverts Midnight's `isHealthy` maxDebt
// formula (contracts.txt:2663-2678) with bit-exact rounding so a created position is healthy by a
// known `drawdownBps` margin: it becomes liquidatable once the WETH oracle price falls by that much.
// Uses the bot's own `mulDivDown`/`mulDivUp` (UtilsLib mirrors) so the numbers match the chain.

import { mulDivDown, mulDivUp } from '../../src/sizing/math'

const WAD = 10n ** 18n
const ORACLE_PRICE_SCALE = 10n ** 36n
const BPS = 10_000n

/**
 * Given the live oracle `price`, the collateral `lltv`, a target debt in loan-token base units, and
 * a `drawdownBps` price-drop buffer, returns the collateral to supply, the resulting on-chain
 * `maxDebt`, and the `units` of debt to take. Guarantees `units <= maxDebt` (so `take`'s seller-health
 * check passes) and `units = floor(maxDebt * (1 - drawdown))`, so a `drawdownBps` price drop makes
 * `maxDebt < units` (liquidatable).
 */
export function sizePosition({
  price,
  lltv,
  debtTargetUnits,
  drawdownBps
}: {
  price: bigint
  lltv: bigint
  debtTargetUnits: bigint
  drawdownBps: number
}) {
  const keep = BPS - BigInt(drawdownBps) // (1 - drawdown), in bps
  // Required maxDebt so that, after the drawdown haircut, `units` ≈ the target debt.
  const requiredMaxDebt = mulDivUp(debtTargetUnits, BPS, keep)
  // Invert maxDebt = floor(floor(collateral·price/SCALE)·lltv/WAD): round each step UP so the
  // realized maxDebt lands at or above the requirement.
  const minCollateralValue = mulDivUp(requiredMaxDebt, WAD, lltv)
  const collateral = mulDivUp(minCollateralValue, ORACLE_PRICE_SCALE, price)
  const maxDebt = mulDivDown(mulDivDown(collateral, price, ORACLE_PRICE_SCALE), lltv, WAD)
  const units = mulDivDown(maxDebt, keep, BPS)
  return { collateral, maxDebt, units }
}

/** The real price drop (bps) that flips a position liquidatable: `floor((maxDebt - units)·1e4/maxDebt)`. */
export function priceDropToLiquidateBps(maxDebt: bigint, units: bigint) {
  if (maxDebt === 0n) return 0n
  return mulDivDown(maxDebt - units, BPS, maxDebt)
}
