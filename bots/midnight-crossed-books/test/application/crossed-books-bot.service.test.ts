import { describe, expect, mock, test } from 'bun:test'

import type {
  ListedMarketsService,
  OrderBookService,
  ResolverService
} from '../../src/application/crossed-books-bot.service'
import type { MatchingServicePort } from '../../src/domain/matching.service'
import type {
  CrossedMatch,
  ListedMarket,
  PreparedResolution,
  SimulationResult
} from '../../src/domain/order-book'

import { CrossedBooksBotService } from '../../src/application/crossed-books-bot.service'
import { MARKET_ID, OTHER_MARKET_ID, makeOffer } from '../fixtures/offers'

const MARKET: ListedMarket = { marketId: MARKET_ID }
const OTHER_MARKET: ListedMarket = { marketId: OTHER_MARKET_ID }
const MATCH: CrossedMatch = {
  ask: makeOffer('ask', 5n, 2n),
  bid: makeOffer('bid', 7n, 2n),
  units: 2n
}
const SECOND_MATCH: CrossedMatch = {
  ask: makeOffer('ask', 6n, 3n),
  bid: makeOffer('bid', 7n, 3n),
  units: 3n
}

function setup(
  overrides: {
    markets?: ListedMarket[]
    inflight?: ReadonlySet<string>
    matches?: CrossedMatch[]
    simulation?: SimulationResult
    booksError?: Error
    maxMatches?: number
  } = {}
) {
  const listListedActiveMarkets = mock(async () => overrides.markets ?? [MARKET])
  const getTakeableBook = mock(async () => {
    if (overrides.booksError) throw overrides.booksError
    return { asks: [MATCH.ask], bids: [MATCH.bid] }
  })
  const match = mock(() => overrides.matches ?? [MATCH, SECOND_MATCH])
  const simulate = mock(
    async (): Promise<SimulationResult> =>
      overrides.simulation ?? {
        status: 'ok',
        prepared: { marketId: MARKET_ID, data: '0x1234', profit: 1n }
      }
  )
  const submit = mock(async () => undefined)
  const markets: ListedMarketsService = { listListedActiveMarkets }
  const books: OrderBookService = { getTakeableBook }
  const matching: MatchingServicePort = { match }
  const resolver: ResolverService = { simulate, submit }
  const logger = {
    info: mock(() => undefined),
    warn: mock(() => undefined)
  }
  const service = new CrossedBooksBotService(
    markets,
    books,
    matching,
    resolver,
    overrides.maxMatches ?? 10,
    () => overrides.inflight ?? new Set(),
    logger
  )

  return {
    service,
    books,
    listListedActiveMarkets,
    getTakeableBook,
    match,
    simulate,
    submit
  }
}

describe('CrossedBooksBotService', () => {
  test('loads listed active markets once per run', async () => {
    const { service, listListedActiveMarkets } = setup()

    await service.run({ blockNumber: 10n })

    expect(listListedActiveMarkets).toHaveBeenCalledTimes(1)
  })

  test('skips a market with an in-flight transaction', async () => {
    const { service, getTakeableBook, simulate } = setup({
      inflight: new Set([MARKET_ID])
    })

    const result = await service.run({ blockNumber: 10n })

    expect(result).toEqual({ submitted: false, markets: 1 })
    expect(getTakeableBook).not.toHaveBeenCalled()
    expect(simulate).not.toHaveBeenCalled()
  })

  test('does not simulate or submit when books do not cross', async () => {
    const { service, simulate, submit } = setup({ matches: [] })

    await service.run({ blockNumber: 10n })

    expect(simulate).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  test('does not submit a reverted simulation', async () => {
    const { service, submit } = setup({
      simulation: { status: 'revert', reason: 'InsufficientProfit' }
    })

    await service.run({ blockNumber: 10n })

    expect(submit).not.toHaveBeenCalled()
  })

  test('simulates every crossed offer in one resolution', async () => {
    const { service, match, simulate } = setup()

    await service.run({ blockNumber: 10n })

    expect(match).toHaveBeenCalledWith({
      asks: [MATCH.ask],
      bids: [MATCH.bid],
      maxMatches: 10
    })
    expect(simulate).toHaveBeenCalledWith([MATCH, SECOND_MATCH])
  })

  test('uses the configured match cap', async () => {
    const { service, match } = setup({ maxMatches: 3 })

    await service.run({ blockNumber: 10n })

    expect(match).toHaveBeenCalledWith({
      asks: [MATCH.ask],
      bids: [MATCH.bid],
      maxMatches: 3
    })
  })

  test('submits exactly the prepared request returned by simulation', async () => {
    const prepared: PreparedResolution = {
      marketId: MARKET_ID,
      data: '0x1234',
      profit: 42n
    }
    const { service, submit } = setup({ simulation: { status: 'ok', prepared } })

    const result = await service.run({ blockNumber: 10n })

    expect(submit).toHaveBeenCalledWith(prepared, 10n)
    expect(result).toEqual({ submitted: true, markets: 1 })
  })

  test('isolates a book failure and continues to the next market', async () => {
    let calls = 0
    const { service, books, submit } = setup({ markets: [MARKET, OTHER_MARKET] })
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
    expect(submit).toHaveBeenCalledTimes(1)
    expect(result.submitted).toBe(true)
  })

  test('stops after the first successful submission', async () => {
    const { service, getTakeableBook, submit } = setup({ markets: [MARKET, OTHER_MARKET] })

    await service.run({ blockNumber: 10n })

    expect(getTakeableBook).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(1)
  })
})
