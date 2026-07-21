import type { Address } from 'viem'

// The make-order book's domain model, shared by the poller that diffs it and the AlertFormatter
// that renders its events. It lives apart from both so `bucketKey` has a single definition (the
// poller keys its snapshot with it; the formatter builds the alert key with it) and so the
// formatter never has to runtime-import the heavy stateful poller module.

export type BookSide = 'asks' | 'bids'

/**
 * One (side, maker, group, tick) bucket of a market's book. Offers carry no server-side id — they
 * are immutable signed payloads that makers cancel and re-sign to change — so identity is derived
 * from the fields that survive a re-sign. Several offers can share a bucket; their signed caps are
 * summed, which is also the number an operator cares about ("this maker has N at this tick").
 */
export type OfferBucket = {
  side: BookSide
  maker: Address
  group: string
  tick: number
  /** Summed `max_units` across the bucket's offers. Unit-capped offers populate this. */
  maxUnits: string
  /** Summed `max_assets` across the bucket's offers. Asset-capped offers populate this. */
  maxAssets: string
  count: number
  /** Earliest expiry in the bucket. Display only — never compared (offers roll constantly). */
  expiry: number
}

export type MarketSnapshot = Record<string, OfferBucket>

/** What the stored and freshly-fetched snapshots disagree about — the poller's diff output. */
export type OfferEvent = {
  kind: 'created' | 'resized' | 'closed'
  marketId: string
  /** Current bucket for created/resized; the last known one for closed. */
  bucket: OfferBucket
  /** Bucket before the change; null unless resized. */
  previous: OfferBucket | null
  /** `bucket` sized in loan-token assets; null when the tick carries no local price. */
  assets: bigint | null
  /** `previous` sized in loan-token assets; null unless resized with a priced tick. */
  previousAssets: bigint | null
  /** 1e18-scaled book price at `bucket.tick`, when the tick is among the returned levels. */
  price: string | null
}

export function bucketKey(side: BookSide, maker: Address, group: string, tick: number) {
  return `${side}:${maker}:${group}:${tick}`
}
