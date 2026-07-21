import { describe, expect, mock, test } from 'bun:test'

import type {
  ListedMarketsService,
  OrderBookService,
  ResolverService
} from '../../src/application/crossed-books-bot.service'
import { CrossedBooksBotService } from '../../src/application/crossed-books-bot.service'
import type { MatchingServicePort } from '../../src/domain/matching.service'
import type { CrossedMatch, ListedMarket } from '../../src/domain/order-book'
import { MARKET_ID, OTHER_MARKET_ID, makeOffer } from '../fixtures/offers'

const MARKET: ListedMarket = { marketId: MARKET_ID }
const OTHER_MARKET: ListedMarket = { marketId: OTHER_MARKET_ID }
const MATCH: CrossedMatch = {
  ask: makeOffer('ask', 5n, 2n),
  bid: makeOffer('bid', 7n, 2n),
  units: 2n
}

function setup(overrides: {
  markets?: ListedMarket[]
  inflight?: ReadonlySet<string>
  matches?: CrossedMatch[]
  simulation?: { status: 'ok'; prepared: { marketId: typeof MARKET_ID; data: '0x1234'; profit: bigint } } | { status: 'revert'; reason: string }
  booksError?: Error
} = {}) {
  const markets: ListedMarketsService = {
    listListedActiveMarkets: mock(async () => overrides.markets ?? [MARKET])
  }
  const books: OrderBookService = {
    getTakeableBook: mock(async () => {
      if (overrides.booksError) throw overrides.booksError
      return { asks: [MATCH.ask], bids: [MATCH.bid] }
    })
  }
  const matching: MatchingServicePort = {
    match: mock(() => overrides.matches ?? [MATCH])
  }
  const resolver: ResolverService = {
    simulate: mock(async () =>
      overrides.simulation ?? {
        status: 'ok' as const,
        prepared: { marketId: MARKET_ID, data: '0x1234', profit: 1n }
      }
    ),
    submit: mock(async () => undefined)
  }
  const logger = {
    info: mock(() => undefined),
    warn: mock(() => undefined)
  }
  const service = new CrossedBooksBotService(
    markets,
    books,
    matching,
    resolver,
    () => overrides.inflight ?? new Set(),
    logger
  )

  return { service, markets, books, matching, resolver, logger }
}

describe('CrossedBooksBotService', () => {
  test('loads listed active markets once per run', async () => {
    const { service, markets } = setup()

    await service.run({ blockNumber: 10n })

    expect(markets.listListedActiveMarkets).toHaveBeenCalledTimes(1)
  })

  test('skips a market with an in-flight transaction', async () => {
    const { service, books, resolver } = setup({ inflight: new Set([MARKET_ID]) })

    const result = await service.run({ blockNumber: 10n })

    expect(result).toEqual({ submitted: false, markets: 1 })
    expect(books.getTakeableBook).not.toHaveBeenCalled()
    expect(resolver.simulate).not.toHaveBeenCalled()
  })

  test('does not simulate or submit when books do not cross', async () => {
    const { service, resolver } = setup({ matches: [] })

    await service.run({ blockNumber: 10n })

    expect(resolver.simulate).not.toHaveBeenCalled()
    expect(resolver.submit).not.toHaveBeenCalled()
  })

  test('does not submit a reverted simulation', async () => {
    const { service, resolver } = setup({
      simulation: { status: 'revert', reason: 'InsufficientProfit' }
    })

    await service.run({ blockNumber: 10n })

    expect(resolver.submit).not.toHaveBeenCalled()
  })

  test('submits exactly the prepared request returned by simulation', async () => {
    const prepared = { marketId: MARKET_ID, data: '0x1234' as const, profit: 42n }
    const { service, resolver } = setup({ simulation: { status: 'ok', prepared } })

    const result = await service.run({ blockNumber: 10n })

    expect(resolver.submit).toHaveBeenCalledWith(prepared, 10n)
    expect(result).toEqual({ submitted: true, markets: 1 })
  })

  test('isolates a book failure and continues to the next market', async () => {
    let calls = 0
    const { service, books, resolver } = setup({ markets: [MARKET, OTHER_MARKET] })
    books.getTakeableBook = mock(async marketId => {
      calls += 1
      if (marketId === MARKET_ID) throw new Error('router unavailable')
      return {
        asks: [makeOffer('ask', 5n, 2n, { marketId: OTHER_MARKET_ID })],
        bids: [makeOffer('bid', 7n, 2n, { marketId: OTHER_MARKET_ID })]
      }
    })

    const result = await service.run({ blockNumber: 10n })

    expect(calls).toBe(2)
    expect(resolver.submit).toHaveBeenCalledTimes(1)
    expect(result.submitted).toBe(true)
  })

  test('stops after the first successful submission', async () => {
    const { service, books, resolver } = setup({ markets: [MARKET, OTHER_MARKET] })

    await service.run({ blockNumber: 10n })

    expect(books.getTakeableBook).toHaveBeenCalledTimes(1)
    expect(resolver.submit).toHaveBeenCalledTimes(1)
  })
})
