import type { CrossedMatch, TakeableOffer } from './order-book'

export interface MatchingServicePort {
  match(parameters: {
    asks: readonly TakeableOffer[]
    bids: readonly TakeableOffer[]
    maxMatches?: number
  }): CrossedMatch[]
}

function compareTicksAscending(left: TakeableOffer, right: TakeableOffer) {
  if (left.offer.tick < right.offer.tick) return -1
  if (left.offer.tick > right.offer.tick) return 1
  return 0
}

function compareTicksDescending(left: TakeableOffer, right: TakeableOffer) {
  return -compareTicksAscending(left, right)
}

export class MatchingService implements MatchingServicePort {
  match({
    asks,
    bids,
    maxMatches = 1
  }: {
    asks: readonly TakeableOffer[]
    bids: readonly TakeableOffer[]
    maxMatches?: number
  }): CrossedMatch[] {
    const sortedAsks = asks
      .filter(offer => !offer.offer.buy && offer.units > 0n)
      .toSorted(compareTicksAscending)
    const sortedBids = bids
      .filter(offer => offer.offer.buy && offer.units > 0n)
      .toSorted(compareTicksDescending)

    const remainingAskUnits = sortedAsks.map(offer => offer.units)
    const remainingBidUnits = sortedBids.map(offer => offer.units)
    const matches: CrossedMatch[] = []

    let askIndex = 0
    let bidIndex = 0

    while (
      askIndex < sortedAsks.length &&
      bidIndex < sortedBids.length &&
      matches.length < maxMatches
    ) {
      const ask = sortedAsks[askIndex]!
      const bid = sortedBids[bidIndex]!

      if (ask.marketId !== bid.marketId || bid.offer.tick <= ask.offer.tick) break

      const askUnits = remainingAskUnits[askIndex]!
      const bidUnits = remainingBidUnits[bidIndex]!
      const units = askUnits < bidUnits ? askUnits : bidUnits

      matches.push({ ask, bid, units })

      const nextAskUnits = askUnits - units
      const nextBidUnits = bidUnits - units
      remainingAskUnits[askIndex] = nextAskUnits
      remainingBidUnits[bidIndex] = nextBidUnits

      if (nextAskUnits === 0n) askIndex += 1
      if (nextBidUnits === 0n) bidIndex += 1
    }

    return matches
  }
}
