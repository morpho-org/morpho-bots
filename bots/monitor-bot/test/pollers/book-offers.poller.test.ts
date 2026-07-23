import { describe, expect, it, vi } from 'vitest'

import type { MidnightClient } from '../../src/midnight/client'
import type { MarketSnapshot, OfferBucket } from '../../src/pollers/book-offers.model'

import { AlertFormatter } from '../../src/alerts/formatter'
import { BookOffersPoller, diffSnapshots } from '../../src/pollers/book-offers.poller'
import { InMemoryBootSnapshotStore } from '../../src/snapshot/boot-snapshot.store'
import { TokenRegistry } from '../../src/tokens/registry'
import { InMemoryWalletCrmStore } from '../../src/wallets/wallet-crm.store'
import { capturingDispatcher, fakeLogger } from '../helpers'
import { apiPage, MARKET_A, MARKET_B, NO_PRICES, USER_ONE, USER_TWO } from '../midnight/fixtures'

const GROUP_1 = `0x${'1'.repeat(64)}`
const GROUP_2 = `0x${'2'.repeat(64)}`
const WAD = '1000000000000000000'
const DEFAULT_TICK = 495
/** MARKET_A through the alert formatter's market label: the fixture books carry USER_TWO as an
 * unresolvable loan token and no collaterals, so the label degrades to the abbreviated loan token
 * (the maturity now lives in each order's `Expiry` line, not the label). */
const MARKET_A_LABEL = '0x5356...4C91'
/** Every order alert carries the offer's own expiry; the fixtures default to 2000 unix seconds. */
const EXPIRES = ', expires 01/01/1970'
/** Every offer alert ends with the linked maker, the deployment label, and the observation time. */
const TAIL = ' by 0x958e...1917 on midnight-base at 14/11/2023 - 22:13:20 UTC'

type Side = 'asks' | 'bids'

type OfferSpec = {
  maker?: string
  group?: string
  tick?: number
  max_units?: string
  max_assets?: string
  expiry?: number
}

/**
 * `levelsOnly` decouples the book's aggregated ask levels from the offers behind them, so tests
 * can reproduce the real skew between the two endpoints (levels report executable liquidity;
 * takeable-offers keeps non-executable offers with units 0). Omitted, levels mirror the offers.
 */
type MarketSpec = {
  asks?: OfferSpec[]
  bids?: OfferSpec[]
  levelsOnly?: OfferSpec[]
  /** Defaults to 2000 — already matured against the frozen clock, so titles omit the rate. */
  maturity?: number
}

/** One poll tick's view of the world: every market's book and the offers behind each side. */
type TickSpec = Record<string, MarketSpec>

// `maturity` mirrors the book listing's so the embedded market never contradicts the book the
// offer belongs to — the poller reads it from the listing, but the shapes must agree.
function takeableOffer(marketId: string, side: Side, spec: OfferSpec, maturity = 2000) {
  return {
    units: spec.max_units ?? '1000',
    market_id: marketId,
    ratifier_data: '0x',
    offer: {
      market: {
        chain_id: 8453,
        midnight: USER_TWO,
        loan_token: USER_TWO,
        collaterals: [],
        maturity,
        rcf_threshold: '0',
        enter_gate: USER_TWO,
        liquidator_gate: USER_TWO
      },
      buy: side === 'bids',
      maker: spec.maker ?? USER_ONE,
      max_units: spec.max_units ?? '1000',
      start: 100,
      expiry: spec.expiry ?? 2000,
      tick: spec.tick ?? DEFAULT_TICK,
      group: spec.group ?? GROUP_1,
      callback: USER_TWO,
      callback_data: '0x',
      receiver_if_maker_is_seller: USER_TWO,
      ratifier: USER_TWO,
      reduce_only: false,
      max_assets: spec.max_assets ?? '0',
      continuous_fee_cap: '0'
    }
  }
}

// Levels mirror the offers so an empty side really has no levels (and no takeable-offers call).
// price = 1 WAD keeps derived assets equal to units, so titles read in whole numbers.
function levels(offers: OfferSpec[] = []) {
  return [...new Set(offers.map(offer => offer.tick ?? DEFAULT_TICK))].map(tick => ({
    tick,
    price: WAD,
    units: '0',
    assets: '0',
    count: 1
  }))
}

function bookEntry(marketId: string, spec: MarketSpec) {
  return {
    market_id: marketId,
    chain_id: 8453,
    midnight: USER_TWO,
    loan_token: USER_TWO,
    collaterals: [],
    maturity: spec.maturity ?? 2000,
    rcf_threshold: '0',
    enter_gate: USER_TWO,
    liquidator_gate: USER_TWO,
    asks: levels(spec.levelsOnly ?? spec.asks),
    bids: levels(spec.bids)
  }
}

type GetParams = { params?: { path?: Record<string, string>; query?: Record<string, unknown> } }

/**
 * Routes by path and serves one TickSpec per `/v0/midnight/books` call, so a poll tick's
 * takeable-offers requests all read the same world the listing described.
 */
function makePoller(ticks: TickSpec[], minAssets = 0n, marketIds: string[] = []) {
  const failing = new Set<string>()
  let listing = 0
  let active: TickSpec = {}
  const GET = vi.fn((path: string, init: GetParams) => {
    if (path === '/v0/midnight/books') {
      active = ticks[Math.min(listing, ticks.length - 1)] ?? {}
      listing++
      const data = Object.entries(active).map(([id, spec]) => bookEntry(id, spec))
      return Promise.resolve(apiPage({ cursor: null, data }))
    }
    const marketId = init.params?.path?.['market-id'] ?? ''
    const side = (init.params?.path?.side ?? 'asks') as Side
    if (failing.has(marketId)) return Promise.reject(new Error('boom'))
    const offers = active[marketId]?.[side] ?? []
    return Promise.resolve(
      apiPage({
        data: offers.map(offer => takeableOffer(marketId, side, offer, active[marketId]?.maturity))
      })
    )
  })
  const client = { GET } as unknown as MidnightClient
  const dispatcher = capturingDispatcher()
  const logger = fakeLogger()
  // The formatter shares the poller's registry so the market `recordAll` records is visible to it.
  const tokens = new TokenRegistry()
  const poller = new BookOffersPoller(
    { cron: '*/30 * * * * *', marketIds },
    {
      state: new InMemoryBootSnapshotStore(),
      dispatcher,
      logger,
      tokens,
      formatter: new AlertFormatter({
        tokens,
        prices: NO_PRICES,
        wallets: new InMemoryWalletCrmStore()
      }),
      client,
      minAssets,
      sleep: () => Promise.resolve(),
      // Frozen observation clock so alert titles are deterministic (TAIL's timestamp).
      now: () => 1_700_000_000_000
    }
  )
  return { poller, dispatcher, logger, client, failing, GET }
}

function firstAlert(dispatcher: ReturnType<typeof capturingDispatcher>) {
  return dispatcher.sent[0]?.[0]
}

describe('BookOffersPoller', () => {
  it('treats the first tick per market as a quiet baseline', async () => {
    const { poller, dispatcher, logger } = makePoller([{ [MARKET_A]: { asks: [{}] } }])
    await poller.pollOnce()
    expect(dispatcher.sent).toEqual([])
    expect(logger.info).toHaveBeenCalledWith('poll.baseline', {
      pollerId: 'make-orders',
      marketId: MARKET_A,
      buckets: 1
    })
  })

  it('alerts on a newly posted offer after the baseline', async () => {
    const { poller, dispatcher } = makePoller([
      { [MARKET_A]: { asks: [{}] } },
      { [MARKET_A]: { asks: [{}, { group: GROUP_2, tick: 500, max_units: '500' }] } }
    ])
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent).toHaveLength(1)
    expect(firstAlert(dispatcher)?.key).toBe(`${MARKET_A}:asks:${USER_ONE}:${GROUP_2}:500:created`)
    expect(firstAlert(dispatcher)?.title).toBe(
      `Borrow Order Posted: 500 assets in ${MARKET_A_LABEL}${EXPIRES}${TAIL}`
    )
  })

  it('quotes the tick as an APR when the market has not matured', async () => {
    // One year past the frozen observation clock, so tick 4250's period rate annualizes to 1.25%.
    // The fixture default of 2000 sits before the clock, which is why every other title in this
    // file omits the rate clause.
    const maturity = 1_700_000_000 + 31_536_000
    const { poller, dispatcher } = makePoller([
      { [MARKET_A]: { maturity, asks: [{}] } },
      { [MARKET_A]: { maturity, asks: [{}, { group: GROUP_2, tick: 4250 }] } }
    ])
    await poller.pollOnce()
    await poller.pollOnce()
    expect(firstAlert(dispatcher)?.title).toBe(
      `Borrow Order Posted: 1000 assets at 1.25% in ${MARKET_A_LABEL}${EXPIRES}${TAIL}`
    )
  })

  it('labels bid-side offers as lend', async () => {
    const { poller, dispatcher } = makePoller([
      { [MARKET_A]: { bids: [{}] } },
      { [MARKET_A]: { bids: [{}, { group: GROUP_2 }] } }
    ])
    await poller.pollOnce()
    await poller.pollOnce()
    expect(firstAlert(dispatcher)?.title).toBe(
      `Lend Order Posted: 1000 assets in ${MARKET_A_LABEL}${EXPIRES}${TAIL}`
    )
  })

  it('alerts when a bucket changes size', async () => {
    const { poller, dispatcher } = makePoller([
      { [MARKET_A]: { asks: [{ max_units: '1000' }] } },
      { [MARKET_A]: { asks: [{ max_units: '2000' }] } }
    ])
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent).toHaveLength(1)
    expect(firstAlert(dispatcher)?.title).toBe(
      `Borrow Order Resized: 2000 assets, was 1000 assets in ${MARKET_A_LABEL}${EXPIRES}${TAIL}`
    )
    // The previous size renders as its own indented field line in the mrkdwn text.
    expect(firstAlert(dispatcher)?.text).toContain('   ↩️ Previous: 1000 assets')
  })

  it('ignores a re-signed offer that only moves its expiry', async () => {
    const { poller, dispatcher } = makePoller([
      { [MARKET_A]: { asks: [{ expiry: 2000 }] } },
      { [MARKET_A]: { asks: [{ expiry: 9000 }] } }
    ])
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent).toEqual([])
  })

  it('sums offers that share a maker, group and tick', async () => {
    const { poller, dispatcher } = makePoller([
      { [MARKET_A]: { asks: [{ max_units: '1000' }] } },
      { [MARKET_A]: { asks: [{ max_units: '1000' }, { max_units: '400' }] } }
    ])
    await poller.pollOnce()
    await poller.pollOnce()
    expect(firstAlert(dispatcher)?.title).toBe(
      `Borrow Order Resized: 1400 assets, was 1000 assets in ${MARKET_A_LABEL}${EXPIRES}${TAIL}`
    )
    // The mrkdwn text carries the maker as a basescan link.
    expect(firstAlert(dispatcher)?.text).toContain(
      `<https://basescan.org/address/${USER_ONE}|0x958e...1917>`
    )
    // The link row labels the maker's explorer-address and Debank portfolio pages.
    expect(firstAlert(dispatcher)?.text).toContain(
      `<https://basescan.org/address/${USER_ONE}|Basescan>  <https://debank.com/profile/${USER_ONE}|Debank>`
    )
  })

  it('keys buckets per maker so two makers at one tick stay distinct', async () => {
    const { poller, dispatcher } = makePoller([
      { [MARKET_A]: { asks: [{ maker: USER_ONE }] } },
      { [MARKET_A]: { asks: [{ maker: USER_ONE }, { maker: USER_TWO }] } }
    ])
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent).toHaveLength(1)
    expect(firstAlert(dispatcher)?.key).toBe(`${MARKET_A}:asks:${USER_TWO}:${GROUP_1}:495:created`)
  })

  it('alerts when a bucket disappears', async () => {
    const { poller, dispatcher } = makePoller([
      { [MARKET_A]: { asks: [{}] } },
      { [MARKET_A]: { asks: [] } }
    ])
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent).toHaveLength(1)
    expect(firstAlert(dispatcher)?.key).toBe(`${MARKET_A}:asks:${USER_ONE}:${GROUP_1}:495:closed`)
    expect(firstAlert(dispatcher)?.title).toBe(
      `Borrow Order Closed: 1000 units in ${MARKET_A_LABEL}${EXPIRES}${TAIL}`
    )
  })

  it('skips the takeable-offers request for a side with no price levels', async () => {
    const { poller, GET } = makePoller([{ [MARKET_A]: { asks: [{}] } }])
    await poller.pollOnce()
    const paths = GET.mock.calls.map(call => call[0])
    expect(paths).toEqual([
      '/v0/midnight/books',
      '/v0/midnight/books/{market-id}/{side}/takeable-offers'
    ])
    expect(GET.mock.calls[1]?.[1]?.params?.path?.side).toBe('asks')
  })

  it('forgets a market that leaves the book listing instead of closing its whole book', async () => {
    const { poller, dispatcher } = makePoller([
      { [MARKET_A]: { asks: [{}] }, [MARKET_B]: { asks: [{}] } },
      { [MARKET_B]: { asks: [{}] } },
      { [MARKET_A]: { asks: [{}] }, [MARKET_B]: { asks: [{}] } }
    ])
    await poller.pollOnce()
    await poller.pollOnce()
    // MARKET_A vanished: no closed storm.
    expect(dispatcher.sent).toEqual([])
    // It returns with the same book — re-baselined, so no created storm either.
    await poller.pollOnce()
    expect(dispatcher.sent).toEqual([])
  })

  it('applies the size filter using assets derived from the tick price', async () => {
    const { poller, dispatcher } = makePoller(
      [
        { [MARKET_A]: { asks: [{}] } },
        { [MARKET_A]: { asks: [{}, { group: GROUP_2, max_units: '5' }] } }
      ],
      100n
    )
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent).toEqual([])
  })

  it('re-checks a side that still holds buckets even when its levels report empty', async () => {
    // Levels are aggregated *executable* liquidity from a different endpoint than the offers;
    // takeable-offers keeps non-executable offers with units 0. A side reporting zero levels while
    // its offers still stand must not be recorded as empty, or every bucket on it would close and
    // immediately re-open. `levelsOnly` drops the levels but keeps the offers.
    const { poller, dispatcher, GET } = makePoller([
      { [MARKET_A]: { asks: [{}] } },
      { [MARKET_A]: { asks: [{}], levelsOnly: [] } },
      { [MARKET_A]: { asks: [{}] } }
    ])
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent).toEqual([])
    // The side was still fetched despite reporting no levels.
    const sides = GET.mock.calls.filter(call => call[0].endsWith('takeable-offers'))
    expect(sides).toHaveLength(2)

    await poller.pollOnce()
    expect(dispatcher.sent).toEqual([])
  })

  it('stops re-checking a side once it is genuinely empty', async () => {
    const { poller, GET } = makePoller([
      { [MARKET_A]: { asks: [{}] } },
      { [MARKET_A]: { asks: [] } },
      { [MARKET_A]: { asks: [] } }
    ])
    await poller.pollOnce()
    await poller.pollOnce()
    await poller.pollOnce()
    // Tick 1 fetched, tick 2 re-checked the drained side, tick 3 skipped it (no buckets held).
    expect(GET.mock.calls.filter(call => call[0].endsWith('takeable-offers'))).toHaveLength(2)
  })

  it('passes an unpriced bucket through the size filter rather than dropping it', async () => {
    // The books LIST response carries only the top 3 levels, so a bucket at a deeper tick has no
    // local price and cannot be sized. It must still alert — a wrong drop loses it permanently.
    const { poller, dispatcher } = makePoller(
      [
        { [MARKET_A]: { asks: [{}] } },
        {
          [MARKET_A]: {
            asks: [{}, { group: GROUP_2, tick: 900, max_units: '5' }],
            levelsOnly: [{}]
          }
        }
      ],
      100n
    )
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent).toHaveLength(1)
    // Unpriced, so the title falls back to units rather than claiming an asset amount.
    expect(firstAlert(dispatcher)?.title).toBe(
      `Borrow Order Posted: 5 units in ${MARKET_A_LABEL}${EXPIRES}${TAIL}`
    )
  })

  it('skips an offer with a malformed maker without failing the whole market', async () => {
    const { poller, dispatcher, logger } = makePoller([
      { [MARKET_A]: { asks: [{}] } },
      { [MARKET_A]: { asks: [{}, { maker: 'not-an-address', group: GROUP_2 }] } }
    ])
    await poller.pollOnce()
    await poller.pollOnce()
    expect(logger.warn).toHaveBeenCalledWith(
      'poll.invalid_maker',
      expect.objectContaining({ pollerId: 'make-orders', maker: 'not-an-address' })
    )
    // The market still baselined and diffed; the bad row simply never became a bucket.
    expect(dispatcher.sent).toEqual([])
  })

  it('applies the size filter to asset-capped offers', async () => {
    const { poller, dispatcher } = makePoller(
      [
        { [MARKET_A]: { asks: [{}] } },
        {
          [MARKET_A]: {
            asks: [{}, { group: GROUP_2, max_units: '0', max_assets: '5000' }]
          }
        }
      ],
      100n
    )
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent).toHaveLength(1)
    expect(firstAlert(dispatcher)?.title).toBe(
      `Borrow Order Posted: 5000 assets in ${MARKET_A_LABEL}${EXPIRES}${TAIL}`
    )
  })

  it('isolates a failing market so other markets still alert', async () => {
    const { poller, dispatcher, logger, failing } = makePoller([
      { [MARKET_A]: { asks: [{}] }, [MARKET_B]: { asks: [{}] } },
      {
        [MARKET_A]: { asks: [{}, { group: GROUP_2 }] },
        [MARKET_B]: { asks: [{}, { group: GROUP_2 }] }
      },
      { [MARKET_A]: { asks: [{}, { group: GROUP_2 }] }, [MARKET_B]: { asks: [{}] } }
    ])
    await poller.pollOnce()

    failing.add(MARKET_A)
    await poller.pollOnce()
    expect(logger.warn).toHaveBeenCalledWith(
      'poll.market_error',
      expect.objectContaining({ pollerId: 'make-orders', marketId: MARKET_A })
    )
    // MARKET_B still produced its created alert.
    expect(dispatcher.sent).toHaveLength(1)
    expect(firstAlert(dispatcher)?.key).toBe(`${MARKET_B}:asks:${USER_ONE}:${GROUP_2}:495:created`)

    // MARKET_A recovers and diffs against its CARRIED baseline, not the failed tick.
    failing.delete(MARKET_A)
    await poller.pollOnce()
    const keys = dispatcher.sent[1]?.map(alert => alert.key)
    expect(keys).toContain(`${MARKET_A}:asks:${USER_ONE}:${GROUP_2}:495:created`)
    expect(keys).toContain(`${MARKET_B}:asks:${USER_ONE}:${GROUP_2}:495:closed`)
  })

  it('baselines quietly when a market fails before it ever had a snapshot', async () => {
    const { poller, dispatcher, logger, failing } = makePoller([
      { [MARKET_A]: { asks: [{}] }, [MARKET_B]: { asks: [{}] } },
      { [MARKET_A]: { asks: [{}] }, [MARKET_B]: { asks: [{}] } }
    ])
    // MARKET_A never completes a baseline tick, so it must stay absent from the cursor — an empty
    // snapshot would read as "the book was empty" and report the whole book as created on recovery.
    failing.add(MARKET_A)
    await poller.pollOnce()
    expect(dispatcher.sent).toEqual([])

    failing.delete(MARKET_A)
    await poller.pollOnce()
    expect(dispatcher.sent).toEqual([])
    expect(logger.info).toHaveBeenCalledWith('poll.baseline', {
      pollerId: 'make-orders',
      marketId: MARKET_A,
      buckets: 1
    })
  })

  it('throws when every market fails', async () => {
    const { poller, failing } = makePoller([{ [MARKET_A]: { asks: [{}] } }])
    failing.add(MARKET_A)
    await expect(poller.pollOnce()).rejects.toThrow('all 1 books failed')
  })

  it('treats a capped takeable-offers side as failed instead of diffing a truncated book', async () => {
    const many = Array.from({ length: 1000 }, (_, index) => ({ group: `0x${index}`, tick: 495 }))
    const { poller, dispatcher, logger } = makePoller([
      { [MARKET_A]: { asks: [{}] } },
      { [MARKET_A]: { asks: many } },
      { [MARKET_A]: { asks: [] } }
    ])
    await poller.pollOnce()

    await expect(poller.pollOnce()).rejects.toThrow('all 1 books failed')
    expect(logger.warn).toHaveBeenCalledWith(
      'poll.offers_capped',
      expect.objectContaining({ pollerId: 'make-orders', marketId: MARKET_A, side: 'asks' })
    )
    expect(dispatcher.sent).toEqual([])

    // Recovery diffs against the CARRIED baseline, not the truncated snapshot.
    await poller.pollOnce()
    expect(dispatcher.sent).toHaveLength(1)
    expect(firstAlert(dispatcher)?.key).toBe(`${MARKET_A}:asks:${USER_ONE}:${GROUP_1}:495:closed`)
  })

  it('aborts the tick when the book listing never stops paginating', async () => {
    const dispatcher = capturingDispatcher()
    const logger = fakeLogger()
    const client = {
      GET: vi.fn((path: string) =>
        path === '/v0/midnight/books'
          ? Promise.resolve(
              apiPage({ cursor: 'more', data: [bookEntry(MARKET_A, { asks: [{}] })] })
            )
          : Promise.resolve(apiPage({ data: [] }))
      )
    } as unknown as MidnightClient
    const tokens = new TokenRegistry()
    const poller = new BookOffersPoller(
      { cron: '*/30 * * * * *', marketIds: [] },
      {
        state: new InMemoryBootSnapshotStore(),
        dispatcher,
        logger,
        tokens,
        formatter: new AlertFormatter({
          tokens,
          prices: NO_PRICES,
          wallets: new InMemoryWalletCrmStore()
        }),
        client,
        minAssets: 0n,
        sleep: () => Promise.resolve()
      }
    )
    await expect(poller.pollOnce()).rejects.toThrow('books pagination capped at 100 pages')
    expect(logger.warn).toHaveBeenCalledWith(
      'poll.pages_capped',
      expect.objectContaining({ pollerId: 'make-orders', maxPages: 100 })
    )
    expect(dispatcher.sent).toEqual([])
  })

  it('scopes the listing with the ids filter when MARKET_IDS is set', async () => {
    const { poller, GET } = makePoller([{ [MARKET_A]: { asks: [{}] } }], 0n, [MARKET_A, MARKET_B])
    await poller.pollOnce()
    expect(GET.mock.calls[0]?.[1]?.params?.query).toEqual({
      ids: `${MARKET_A},${MARKET_B}`,
      limit: 20
    })
  })
})

// Direct tests of the diff, independent of fetching/pagination/alert formatting. The poller-level
// tests above prove the wiring; these pin the rule that decides what an operator actually sees.
describe('diffSnapshots', () => {
  function bucket(over: Partial<OfferBucket> = {}): OfferBucket {
    return {
      side: 'asks',
      maker: USER_ONE,
      group: GROUP_1,
      tick: DEFAULT_TICK,
      maxUnits: '1000',
      maxAssets: '0',
      count: 1,
      expiry: 2000,
      ...over
    }
  }

  /** Keyed exactly as the poller keys them: `${side}:${maker}:${group}:${tick}`. */
  function snapshot(...buckets: OfferBucket[]): MarketSnapshot {
    return Object.fromEntries(
      buckets.map(entry => [`${entry.side}:${entry.maker}:${entry.group}:${entry.tick}`, entry])
    )
  }

  const prices = new Map([[`asks:${DEFAULT_TICK}`, WAD]])
  const diff = (prev: MarketSnapshot, next: MarketSnapshot) =>
    diffSnapshots(MARKET_A, prev, next, prices)

  it('returns only the new buckets, filtering out every unchanged one', () => {
    const held = bucket({ group: GROUP_1 })
    const alsoHeld = bucket({ group: GROUP_2, tick: 500 })
    const fresh = bucket({ group: GROUP_2, tick: 700, maxUnits: '250' })

    const events = diff(snapshot(held, alsoHeld), snapshot(held, alsoHeld, fresh))

    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('created')
    expect(events[0]?.bucket.tick).toBe(700)
    expect(events[0]?.bucket.maxUnits).toBe('250')
  })

  it('returns nothing when the fetched snapshot matches the stored one', () => {
    const stored = snapshot(bucket({ group: GROUP_1 }), bucket({ group: GROUP_2, tick: 500 }))
    // A fresh object graph with identical values — the diff compares caps, not identity.
    const fetched = snapshot(bucket({ group: GROUP_1 }), bucket({ group: GROUP_2, tick: 500 }))

    expect(diff(stored, fetched)).toEqual([])
  })

  it('treats an empty stored snapshot as every fetched bucket being new', () => {
    const events = diff({}, snapshot(bucket({ group: GROUP_1 }), bucket({ group: GROUP_2 })))

    expect(events).toHaveLength(2)
    expect(events.every(event => event.kind === 'created')).toBe(true)
  })

  it('does not report a bucket as new when only its non-cap fields moved', () => {
    // count and expiry churn on every re-sign; neither is a change an operator wants paged about.
    const stored = snapshot(bucket({ count: 1, expiry: 2000 }))
    const fetched = snapshot(bucket({ count: 4, expiry: 9999 }))

    expect(diff(stored, fetched)).toEqual([])
  })

  it('separates new buckets from resized and closed ones in a mixed diff', () => {
    const unchanged = bucket({ group: GROUP_1 })
    const stored = snapshot(
      unchanged,
      bucket({ group: GROUP_2, maxUnits: '500' }),
      bucket({ group: GROUP_2, tick: 600 })
    )
    const fetched = snapshot(
      unchanged,
      bucket({ group: GROUP_2, maxUnits: '900' }),
      bucket({ group: GROUP_1, tick: 800 })
    )

    const events = diff(stored, fetched)
    const byKind = (kind: string) => events.filter(event => event.kind === kind)

    // Exactly one of each, and the unchanged bucket contributed nothing.
    expect(events).toHaveLength(3)
    expect(byKind('created').map(event => event.bucket.tick)).toEqual([800])
    expect(byKind('resized').map(event => event.bucket.maxUnits)).toEqual(['900'])
    expect(byKind('resized')[0]?.previous?.maxUnits).toBe('500')
    expect(byKind('closed').map(event => event.bucket.tick)).toEqual([600])
  })

  it('keys new buckets so the same group at a different tick is genuinely new', () => {
    const stored = snapshot(bucket({ tick: 495 }))
    const fetched = snapshot(bucket({ tick: 495 }), bucket({ tick: 496 }))

    const events = diff(stored, fetched)
    expect(events).toHaveLength(1)
    expect(events[0]?.bucket.tick).toBe(496)
  })

  it('sizes a new bucket in assets when its tick is priced, and leaves it null otherwise', () => {
    const priced = bucket({ group: GROUP_2, tick: DEFAULT_TICK, maxUnits: '1000' })
    const unpriced = bucket({ group: GROUP_2, tick: 4242, maxUnits: '1000' })

    const events = diff({}, snapshot(priced, unpriced))
    const sized = events.find(event => event.bucket.tick === DEFAULT_TICK)
    const unsized = events.find(event => event.bucket.tick === 4242)

    expect(sized?.assets).toBe(1000n)
    expect(unsized?.assets).toBeNull()
  })
})
