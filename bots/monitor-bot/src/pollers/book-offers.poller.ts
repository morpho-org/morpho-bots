import type { Address } from 'viem'

import { assertNever, delay, ensureError, fetchWithRetry, tryCatch } from '@repo/utils'
import chunk from 'lodash-es/chunk'
import { getAddress, isAddress, parseUnits } from 'viem'

import type { Alert } from '../alerts/alert'
import type { BookMarket, MidnightClient, TakeableOffer } from '../midnight/client'
import type { PollerDependencies } from '../polling/poller'

import { MARKET_CONCURRENCY, REQUEST_TIMEOUT_MS } from '../midnight/client'
import { Poller } from '../polling/poller'

/** `/v0/midnight/books` caps `limit` at 20 — far below the 1000 the other list endpoints allow. */
const BOOK_PAGE_LIMIT = 20

/** Its `ids` filter accepts at most 20 comma-separated market ids per request. */
const BOOK_IDS_PER_REQUEST = 20

/** Book pages walked per tick before giving up — 20 books/page, so ~2000 markets. */
const MAX_BOOK_PAGES = 100

/** `takeable-offers` is unpaginated and returns at most this many offers per book side. */
const TAKEABLE_OFFERS_LIMIT = 1000

const WAD = parseUnits('1', 18)

type BookSide = 'asks' | 'bids'

const SIDES: BookSide[] = ['asks', 'bids']

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

/** Per-market boot snapshot — see `BootSnapshotStore` for why this is not a cursor. */
type BookSnapshot = Record<string, MarketSnapshot>

type OfferEvent = {
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

type BookOffersPollerOptions = { cron: string; marketIds: string[] }

type BookOffersPollerDependencies = PollerDependencies & {
  client: MidnightClient
  minAssets: bigint
  sleep?: (ms: number) => Promise<void>
}

function bucketKey(side: BookSide, maker: Address, group: string, tick: number) {
  return `${side}:${maker}:${group}:${tick}`
}

// Checksummed so a casing change in the API response cannot silently re-key every bucket (which
// would read as every offer closing and an identical set opening). A malformed maker is skipped
// rather than thrown on: failing the market would wedge it forever (never baselines, an opaque
// poll.market_error every tick) over one bad row.
function bucketOffers(
  side: BookSide,
  offers: TakeableOffer[],
  into: MarketSnapshot,
  onInvalid: (maker: string) => void
) {
  for (const { offer } of offers) {
    if (!isAddress(offer.maker)) {
      onInvalid(offer.maker)
      continue
    }
    const maker = getAddress(offer.maker)
    const key = bucketKey(side, maker, offer.group, offer.tick)
    const existing = into[key]
    if (existing) {
      existing.maxUnits = (BigInt(existing.maxUnits) + BigInt(offer.max_units)).toString()
      existing.maxAssets = (BigInt(existing.maxAssets) + BigInt(offer.max_assets)).toString()
      existing.count++
      existing.expiry = Math.min(existing.expiry, offer.expiry)
      continue
    }
    into[key] = {
      side,
      maker,
      group: offer.group,
      tick: offer.tick,
      maxUnits: offer.max_units,
      maxAssets: offer.max_assets,
      count: 1,
      expiry: offer.expiry
    }
  }
}

/**
 * Offers are signed with exactly one cap populated: `max_assets` (asset-capped) or `max_units`
 * (unit-capped, leaving `max_assets` at "0"). FILTER_MIN_ASSETS is denominated in loan-token base
 * units, so a unit-capped bucket is converted with the book price at its tick.
 *
 * Sizing coverage is narrow, and deliberately so: the books LIST response carries only the top 3
 * levels per side, so `prices` holds at most 3 ticks per side and most unit-capped buckets return
 * null — including nearly every `closed` event, since a bucket usually vanishes precisely because
 * its tick drained. A null size is passed through the filter rather than dropped: a wrong drop
 * loses an alert permanently, a wrong pass is only noise. Operators who need FILTER_MIN_ASSETS to
 * bind on unit-capped offers need full-depth levels (`books/{id}?depth=` is one request per
 * market) — a deliberate deferral, since the filter defaults to off.
 */
function assetsOf(bucket: OfferBucket, prices: Map<string, string>) {
  const maxAssets = BigInt(bucket.maxAssets)
  if (maxAssets > 0n) return maxAssets
  const price = prices.get(`${bucket.side}:${bucket.tick}`)
  // `=== undefined`, not falsy: a legitimate price of "0" is a price, not a missing level.
  if (price === undefined) return null
  return (BigInt(bucket.maxUnits) * BigInt(price)) / WAD
}

function priceByTick(book: BookMarket) {
  const prices = new Map<string, string>()
  for (const side of SIDES) {
    for (const level of book[side]) prices.set(`${side}:${level.tick}`, level.price)
  }
  return prices
}

// `count` and `expiry` are deliberately excluded: makers split and re-sign constantly, and the
// takeable `units` field moves on every take (already covered by the transaction pollers).
// Alert-worthy changes are new buckets, signed-cap changes, and disappearances.
function sameSize(a: OfferBucket, b: OfferBucket) {
  return a.maxUnits === b.maxUnits && a.maxAssets === b.maxAssets
}

/**
 * The core of the poller: what the stored snapshot and the freshly fetched one disagree about.
 * Buckets present in both with identical signed caps produce nothing — that is the common case
 * every tick, and filtering it out is what keeps a standing book quiet.
 *
 * Exported for direct unit testing; the poller is its only production caller.
 */
export function diffSnapshots(
  marketId: string,
  prev: MarketSnapshot,
  next: MarketSnapshot,
  prices: Map<string, string>
) {
  const events: OfferEvent[] = []
  const event = (kind: OfferEvent['kind'], bucket: OfferBucket, previous: OfferBucket | null) => ({
    kind,
    marketId,
    bucket,
    previous,
    assets: assetsOf(bucket, prices),
    previousAssets: previous ? assetsOf(previous, prices) : null,
    price: prices.get(`${bucket.side}:${bucket.tick}`) ?? null
  })
  for (const [key, bucket] of Object.entries(next)) {
    const before = prev[key]
    if (!before) events.push(event('created', bucket, null))
    else if (!sameSize(before, bucket)) events.push(event('resized', bucket, before))
  }
  for (const [key, before] of Object.entries(prev)) {
    if (!next[key]) events.push(event('closed', before, null))
  }
  return events
}

function shortId(id: string) {
  return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id
}

// Lending is buying units, so bids are lend-side offers and asks are borrow-side.
function sideLabel(side: BookSide) {
  return side === 'bids' ? 'lend' : 'borrow'
}

function sizeLabel(bucket: OfferBucket, assets: bigint | null) {
  return assets === null ? `${bucket.maxUnits} units` : `${assets} assets`
}

/** Both caps in the dedupe key so an A→B→A→B resize cycle stays distinct for dedupe consumers. */
function capKey(bucket: OfferBucket) {
  return `${bucket.maxUnits}/${bucket.maxAssets}`
}

// Make orders are off-chain EIP-712 signatures — there is no tx to link until one is taken, so
// identity is market + side + maker + group + tick.
function formatOfferAlert(event: OfferEvent): Alert {
  const { bucket, marketId } = event
  const side = sideLabel(bucket.side)
  const size = sizeLabel(bucket, event.assets)
  const key = bucketKey(bucket.side, bucket.maker, bucket.group, bucket.tick)
  const lines = [
    `maker: ${bucket.maker}`,
    `market: ${shortId(marketId)}`,
    `group: ${shortId(bucket.group)}`,
    `tick: ${bucket.tick}${event.price ? ` (price ${event.price})` : ''}`,
    `offers: ${bucket.count}`,
    `expiry: ${bucket.expiry}`
  ]
  switch (event.kind) {
    case 'created':
      return {
        key: `${marketId}:${key}:created`,
        title: `make order posted (${side}): ${size} @ tick ${bucket.tick}`,
        lines,
        severity: 'info'
      }
    case 'resized': {
      const was = event.previous ? sizeLabel(event.previous, event.previousAssets) : 'unknown'
      return {
        key: `${marketId}:${key}:resized:${event.previous ? capKey(event.previous) : '?'}->${capKey(bucket)}`,
        title: `make order resized (${side}): ${size} @ tick ${bucket.tick} (was ${was})`,
        lines,
        severity: 'info'
      }
    }
    case 'closed':
      return {
        key: `${marketId}:${key}:closed`,
        title: `make order closed (${side}): ${size} @ tick ${bucket.tick}`,
        lines,
        severity: 'info'
      }
    default:
      return assertNever(event.kind)
  }
}

/**
 * Watches the protocol-wide make-order book. `/v0/midnight/books` supplies the active-market
 * universe (past maturities excluded) and the top price levels; each market's populated sides are
 * then expanded to individual signed offers via `books/{id}/{side}/takeable-offers`, which needs no
 * maker allowlist. Offers are an active-only snapshot with no change feed, so this poller diffs
 * snapshots.
 *
 * The first tick per market is a quiet baseline: alerting the whole standing book on every boot
 * would be pure noise. A market that drops out of the book listing (matured, delisted, or a
 * transient listing gap) has its snapshot forgotten rather than reported as a wall of `closed`
 * alerts, and re-baselines quietly if it returns — so changes during a listing gap are missed, the
 * same spirit as the created-and-consumed-between-polls miss the transaction pollers document.
 *
 * Delivery nuance vs the base class's at-least-once: a failed dispatch re-diffs against the stale
 * snapshot next tick, which re-derives still-visible events — but an ephemeral change (posted then
 * gone, or resized back) between the failure and the retry is lost.
 */
export class BookOffersPoller extends Poller<BookSnapshot, OfferEvent> {
  readonly id = 'make-orders'
  readonly cron: string
  /** Operator-fixed scope (MARKET_IDS); empty means sweep every active book. */
  private readonly marketIds: string[]

  constructor(
    options: BookOffersPollerOptions,
    private readonly ext: BookOffersPollerDependencies
  ) {
    super(ext)
    this.cron = options.cron
    this.marketIds = options.marketIds
  }

  protected async fetch(snapshot: BookSnapshot | null) {
    // A failure here aborts the whole tick (snapshot untouched) rather than diffing a partial
    // market universe, which would forget every market the sweep did not reach.
    const books = await this.fetchBooks()
    const nextState: BookSnapshot = {}
    const items: OfferEvent[] = []
    let failures = 0
    for (const batch of chunk(books, MARKET_CONCURRENCY)) {
      const results = await Promise.all(batch.map(book => this.pollBook(book, snapshot)))
      for (const result of results) {
        // A market with nothing to carry stays absent from the snapshot, so its next successful
        // tick baselines quietly instead of reporting its whole standing book as created.
        if (result.snapshot !== null) nextState[result.marketId] = result.snapshot
        if (result.failed) failures++
        else items.push(...result.events)
      }
    }
    // Per-market failures keep their own snapshot and retry next tick; only a full sweep failure
    // (systemic outage) aborts the tick so the cron errorHandler surfaces it.
    if (books.length > 0 && failures === books.length) {
      throw new Error(`all ${failures} books failed`)
    }
    return { items, nextState }
  }

  protected toAlerts(items: OfferEvent[]) {
    return items
      .filter(event => event.assets === null || event.assets >= this.ext.minAssets)
      .map(formatOfferAlert)
  }

  // One market's expansion, error-isolated: a market that persistently fails must not starve every
  // other market's alerts forever.
  private async pollBook(book: BookMarket, state: BookSnapshot | null) {
    const marketId = book.market_id
    const prev = state?.[marketId] ?? null
    const { data: snapshot, error } = await tryCatch(this.fetchOffers(book, prev))
    if (error) {
      this.ext.logger.warn('poll.market_error', {
        pollerId: this.id,
        marketId,
        error: ensureError(error).message
      })
      return { marketId, snapshot: prev, failed: true, events: [] }
    }
    if (prev === null) {
      this.ext.logger.info('poll.baseline', {
        pollerId: this.id,
        marketId,
        buckets: Object.keys(snapshot).length
      })
      return { marketId, snapshot, failed: false, events: [] }
    }
    return {
      marketId,
      snapshot,
      failed: false,
      events: diffSnapshots(marketId, prev, snapshot, priceByTick(book))
    }
  }

  private async fetchOffers(book: BookMarket, prev: MarketSnapshot | null) {
    const snapshot: MarketSnapshot = {}
    // Skipping a side with no price levels keeps an empty book to one listing page instead of two
    // round trips per market — but ONLY when that side was already empty last tick. Levels are
    // aggregated *executable* liquidity from a different endpoint than the offers themselves, and
    // takeable-offers keeps non-executable offers with `units: 0`; a side can therefore report
    // zero levels while its offers still stand (indexer skew, or every offer momentarily
    // unexecutable). Skipping then would record the side as empty and close every bucket on it,
    // then re-open them all next tick. Re-checking a side that had buckets costs one request on
    // the tick it actually drains, and nothing thereafter.
    const held = new Set(Object.values(prev ?? {}).map(bucket => bucket.side))
    for (const side of SIDES.filter(
      candidate => book[candidate].length > 0 || held.has(candidate)
    )) {
      const body = await fetchWithRetry(
        () =>
          this.ext.client.GET('/v0/midnight/books/{market-id}/{side}/takeable-offers', {
            params: { path: { 'market-id': book.market_id, side } },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          }),
        { label: `${this.id}.takeable-offers`, sleep: this.ext.sleep ?? delay }
      )
      // The endpoint is unpaginated and trims to the best-priced 1000, so a fuller side would give
      // a truncated snapshot whose tail flaps in and out — fabricating closed/created pairs every
      // tick. Failing routes the market through the failure path (snapshot carried, retried) and
      // stays loud in the logs, which beats emitting bogus alerts.
      if (body.data.length >= TAKEABLE_OFFERS_LIMIT) {
        this.ext.logger.warn('poll.offers_capped', {
          pollerId: this.id,
          marketId: book.market_id,
          side,
          limit: TAKEABLE_OFFERS_LIMIT
        })
        throw new Error(`takeable-offers capped at ${TAKEABLE_OFFERS_LIMIT} for ${book.market_id}`)
      }
      bucketOffers(side, body.data, snapshot, maker =>
        this.ext.logger.warn('poll.invalid_maker', {
          pollerId: this.id,
          marketId: book.market_id,
          side,
          maker
        })
      )
    }
    return snapshot
  }

  private fetchBooks() {
    return this.marketIds.length > 0 ? this.fetchBooksByIds() : this.fetchAllBooks()
  }

  private async fetchBooksByIds() {
    const collected: BookMarket[] = []
    // `ids` takes at most 20 per request and `limit` caps at 20, so one page per chunk is complete.
    for (const ids of chunk(this.marketIds, BOOK_IDS_PER_REQUEST)) {
      const body = await this.getBooks({ ids: ids.join(','), limit: BOOK_PAGE_LIMIT })
      collected.push(...body.data)
      // Asserted rather than assumed: if the API's ids/limit caps ever diverge, a dropped page
      // would silently shrink the market universe and forget every market it omitted.
      if (body.cursor) throw new Error(`books ids page returned a cursor for ${ids.length} ids`)
    }
    return collected
  }

  private async fetchAllBooks() {
    const collected: BookMarket[] = []
    let pageCursor: string | undefined
    for (let page = 0; page < MAX_BOOK_PAGES; page++) {
      const body = await this.getBooks({
        limit: BOOK_PAGE_LIMIT,
        ...(pageCursor ? { cursor: pageCursor } : {})
      })
      collected.push(...body.data)
      if (!body.cursor) return collected
      pageCursor = body.cursor
    }
    this.ext.logger.warn('poll.pages_capped', {
      pollerId: this.id,
      maxPages: MAX_BOOK_PAGES,
      books: collected.length
    })
    // Deliberately stricter than MarketTransactionsPoller, which logs and returns partial data at
    // its own page cap: a truncated *transaction page* only defers items to the next tick, whereas
    // a truncated *market universe* silently forgets the snapshot of every market it never reached.
    throw new Error(`books pagination capped at ${MAX_BOOK_PAGES} pages`)
  }

  private getBooks(query: { ids?: string; limit: number; cursor?: string }) {
    return fetchWithRetry(
      () =>
        this.ext.client.GET('/v0/midnight/books', {
          params: { query },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        }),
      { label: `${this.id}.books`, sleep: this.ext.sleep ?? delay }
    )
  }
}
