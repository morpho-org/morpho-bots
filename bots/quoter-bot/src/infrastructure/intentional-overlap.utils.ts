import type { BookOffer } from '@repo/offers'

/** Ownership evidence attached only after durable strategy-state validation. */
export type OwnedOverlapBookOffer = BookOffer & {
  overlapOwner?: 'bootstrap-buy' | 'ladder-sell'
}

/**
 * Detects a crossed maker book while exempting only one exact, durably owned bootstrap-buy /
 * ladder-sell equality per market.
 * @param offers - Complete selected maker book with optional validated ownership roles.
 * @returns `true` for any strict crossing, tie, missing ownership evidence, wrong-side evidence, or
 * multiple best-side offers; `false` for positive spreads and the narrow intentional equality.
 * @remarks This pure check fails closed. Ownership must be attached by each boundary from durable
 * bootstrap and ladder state; market membership alone is never evidence. Cross-book repricing keeps
 * own offers strictly separated except when both strategies saturate the same hard rate bound, so
 * the exempted equality remains reachable only at that bound and for legacy published overlaps.
 */
export const hasInvalidOwnedBootstrapLadderSpread = (
  offers: readonly OwnedOverlapBookOffer[]
): boolean => {
  const marketIds = new Set(offers.map(offer => offer.marketId))
  for (const marketId of marketIds) {
    const market = offers.filter(offer => offer.marketId === marketId)
    const buys = market.filter(offer => offer.buy)
    const sells = market.filter(offer => !offer.buy)
    if (buys.length === 0 || sells.length === 0) continue
    const highestBuyTick = buys.reduce(
      (highest, offer) => (offer.tick > highest ? offer.tick : highest),
      buys[0]!.tick
    )
    const lowestSellTick = sells.reduce(
      (lowest, offer) => (offer.tick < lowest ? offer.tick : lowest),
      sells[0]!.tick
    )
    if (highestBuyTick < lowestSellTick) continue
    if (highestBuyTick > lowestSellTick) return true
    const highestBuys = buys.filter(offer => offer.tick === highestBuyTick)
    const lowestSells = sells.filter(offer => offer.tick === lowestSellTick)
    if (
      highestBuys.length !== 1 ||
      lowestSells.length !== 1 ||
      highestBuys[0]!.overlapOwner !== 'bootstrap-buy' ||
      lowestSells[0]!.overlapOwner !== 'ladder-sell'
    ) {
      return true
    }
  }
  return false
}
