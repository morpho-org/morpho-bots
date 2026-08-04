import type { Hex } from 'viem'

/** One live or prospective maker offer projected onto the shared book model. */
export type BookOffer = {
  /** Owning offer-group ID when known; prospective offers may omit it. */
  groupId?: Hex
  /** Canonical bytes32 market ID the offer quotes. */
  marketId: Hex
  /** `true` for a buy offer, `false` for a sell. */
  buy: boolean
  /** Exact protocol tick of the offer. */
  tick: bigint
}

/**
 * Batches prospective offers into the retained maker book for one market.
 * @param parameters - Selected market, replaced group IDs, current book, and prospective offers.
 * @returns The resulting selected-market book: retained offers plus every prospective offer,
 * excluding offers owned by a replaced group.
 * @remarks Pure projection: retained offers keep their identity and order; no offer is mutated.
 */
export const batchProspectiveBook = (parameters: {
  marketId: Hex
  replacedGroupIds: ReadonlySet<Hex>
  book: readonly BookOffer[]
  prospective: readonly BookOffer[]
}) =>
  [...parameters.book, ...parameters.prospective].filter(
    offer =>
      offer.marketId === parameters.marketId &&
      (offer.groupId === undefined || !parameters.replacedGroupIds.has(offer.groupId))
  )

/**
 * Detects a crossed book: any buy tick at or above the lowest sell tick.
 * @param offers - Offers of one market's book, mixing both sides.
 * @returns `true` when the book has a negative or zero spread; `false` when a side is empty.
 */
export const hasNegativeSpread = (offers: readonly Pick<BookOffer, 'buy' | 'tick'>[]) => {
  const buys = offers.filter(offer => offer.buy).map(offer => offer.tick)
  const sells = offers.filter(offer => !offer.buy).map(offer => offer.tick)
  if (buys.length === 0 || sells.length === 0) return false

  const highestBuy = buys.reduce((highest, tick) => (tick > highest ? tick : highest))
  const lowestSell = sells.reduce((lowest, tick) => (tick < lowest ? tick : lowest))
  return highestBuy >= lowestSell
}

/**
 * Detects every market whose combined maker book is crossed.
 * @param offers - Validated active maker offers across any number of markets.
 * @returns Canonical IDs, in first-appearance order, of markets having a highest buy tick at or
 * above the lowest sell tick.
 * @remarks Single pass over the offers; markets missing a side are never reported.
 */
export const crossedMarketIds = (
  offers: readonly Pick<BookOffer, 'marketId' | 'buy' | 'tick'>[]
) => {
  const extremes = new Map<Hex, { highestBuy?: bigint; lowestSell?: bigint }>()
  for (const offer of offers) {
    const market = extremes.get(offer.marketId) ?? {}
    if (offer.buy) {
      market.highestBuy =
        market.highestBuy === undefined || offer.tick > market.highestBuy
          ? offer.tick
          : market.highestBuy
    } else {
      market.lowestSell =
        market.lowestSell === undefined || offer.tick < market.lowestSell
          ? offer.tick
          : market.lowestSell
    }
    extremes.set(offer.marketId, market)
  }
  return [...extremes].flatMap(([marketId, market]) =>
    market.highestBuy !== undefined &&
    market.lowestSell !== undefined &&
    market.highestBuy >= market.lowestSell
      ? [marketId]
      : []
  )
}
