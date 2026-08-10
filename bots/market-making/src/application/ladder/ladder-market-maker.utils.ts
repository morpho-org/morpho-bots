import type { LadderQuoteSet } from '../../domain/ladder/ladder'

/**
 * Compares two desired ladder sets by every publication-relevant domain value.
 * @param left - Previously reconciled desired set.
 * @param right - Freshly derived desired set.
 * @returns Whether market, center, grouping, rates, and sizes are exactly equal.
 */
export const sameLadderQuoteSet = (left: LadderQuoteSet, right: LadderQuoteSet) =>
  left.marketId === right.marketId &&
  left.centerRateBps === right.centerRateBps &&
  left.referenceObservationId === right.referenceObservationId &&
  left.groupMode === right.groupMode &&
  left.lower.length === right.lower.length &&
  left.higher.length === right.higher.length &&
  left.lower.every(
    (rung, index) =>
      rung.index === right.lower[index]?.index &&
      rung.rateBps === right.lower[index]?.rateBps &&
      rung.assets === right.lower[index]?.assets
  ) &&
  left.higher.every(
    (rung, index) =>
      rung.index === right.higher[index]?.index &&
      rung.rateBps === right.higher[index]?.rateBps &&
      rung.assets === right.higher[index]?.assets
  )
