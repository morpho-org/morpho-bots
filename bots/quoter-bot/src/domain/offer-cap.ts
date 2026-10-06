import { MAX_OFFER_CAP, TickLib } from '@morpho-org/midnight-sdk'
import { MathLib } from '@morpho-org/morpho-ts'

/**
 * A group's protocol cap: whichever of the offer's `maxAssets` and `maxUnits` is nonzero. Midnight
 * `take` requires exactly one, and counts the group's `consumed` in that dimension. The bot caps
 * every offer in credit `units`; `assets` caps exist only on groups published before that.
 */
export type OfferCap = { kind: 'assets' | 'units'; maximum: bigint }

/**
 * How much of a group's cap is left, in the cap's own dimension.
 * @param cap - The group's protocol cap.
 * @param consumed - The group's protocol consumption; the cancellation sentinel reads as full.
 * @returns `cap.maximum - consumed`, floored at zero.
 */
export const remainingCap = (cap: OfferCap, consumed: bigint) =>
  consumed >= cap.maximum ? 0n : cap.maximum - consumed

/**
 * Whether a group can never be taken again.
 * @param group - The group's cap and whether its offers are maker buys.
 * @param consumed - The group's protocol consumption.
 * @returns For a buy, `true` only at the cancellation sentinel; for a sell, once its cap is used up.
 * @remarks A cash-capped maker buy pays `floor(units × price)` assets per take, so a take small
 * enough to round to zero still adds credit once its cap is used up; only cancellation stops it. A
 * buy is not trusted to be units-capped from ownership records alone, so every buy is cancelled.
 */
export const isGroupClosed = (group: { cap: OfferCap; buy: boolean }, consumed: bigint) =>
  group.buy ? consumed === MAX_OFFER_CAP : consumed >= group.cap.maximum

/**
 * An upper bound on the loan assets a maker buy group can still pay.
 * @param cap - The group's protocol cap.
 * @param consumed - The group's protocol consumption.
 * @param buyTicks - Ticks of the group's buy offers; empty when none is known.
 * @returns A cash cap's remaining assets. A units cap's remaining units priced at its highest buy
 * tick and rounded up, or at face when no tick is known, since no tick prices above one.
 * @remarks The maker pays the tick price: the settlement fee falls on the taker
 * (`TakeAmountsLib.prices`).
 */
export const remainingBuyAssets = (
  cap: OfferCap,
  consumed: bigint,
  buyTicks: readonly bigint[]
) => {
  const remaining = remainingCap(cap, consumed)
  if (cap.kind === 'assets' || buyTicks.length === 0) return remaining
  const price = buyTicks
    .map(tick => TickLib.tickToPrice(tick))
    .reduce((highest, next) => (next > highest ? next : highest))
  return MathLib.mulDiv(remaining, price, MathLib.WAD, 'Up')
}

/**
 * The fewest credit units whose price at `tick` reaches `assets`.
 * @param assets - Loan assets the units must be worth.
 * @param tick - The protocol tick pricing them.
 * @returns `ceil(assets × WAD / price)`, or `undefined` when the tick price is zero (ticks 0 and 1).
 * @remarks Not a bound on what a cash cap admits: a cash-capped buy stays takeable for zero-asset
 * fills, so no finite unit count bounds it.
 */
export const unitsForBuyerAssetsAtTick = (assets: bigint, tick: bigint) => {
  const price = TickLib.tickToPrice(tick)
  return price === 0n ? undefined : MathLib.mulDiv(assets, MathLib.WAD, price, 'Up')
}
