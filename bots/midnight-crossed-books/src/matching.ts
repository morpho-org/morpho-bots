import type { TakeableOffer } from './api'
export type CrossedMatch = { ask: TakeableOffer; bid: TakeableOffer; units: bigint }
const asc = (a: TakeableOffer, b: TakeableOffer) =>
  a.offer.tick < b.offer.tick ? -1 : a.offer.tick > b.offer.tick ? 1 : 0
const desc = (a: TakeableOffer, b: TakeableOffer) => -asc(a, b)
export function matchBooks(
  asks: readonly TakeableOffer[],
  bids: readonly TakeableOffer[],
  maxMatches = 1
): CrossedMatch[] {
  const sell = asks.filter(v => !v.offer.buy && v.units > 0n).toSorted(asc)
  const buy = bids.filter(v => v.offer.buy && v.units > 0n).toSorted(desc)
  const sa = sell.map(v => v.units),
    ba = buy.map(v => v.units)
  const out: CrossedMatch[] = []
  let i = 0,
    j = 0
  while (i < sell.length && j < buy.length && out.length < maxMatches) {
    const ask = sell[i]!,
      bid = buy[j]!
    if (ask.marketId !== bid.marketId || bid.offer.tick <= ask.offer.tick) break
    const units = sa[i]! < ba[j]! ? sa[i]! : ba[j]!
    out.push({ ask, bid, units })
    const remainingAsk = sa[i]! - units
    const remainingBid = ba[j]! - units
    sa[i] = remainingAsk
    ba[j] = remainingBid
    if (remainingAsk === 0n) i++
    if (remainingBid === 0n) j++
  }
  return out
}
