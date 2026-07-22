import type { Hex } from 'viem'

import type { MatchingServicePort } from '../domain/matching.service'
import type {
  CrossedMatch,
  ListedMarket,
  MarketId,
  PreparedResolution,
  SimulationResult,
  TakeableBook
} from '../domain/order-book'

export interface ListedMarketsService {
  listListedActiveMarkets(): Promise<ListedMarket[]>
}

export interface OrderBookService {
  getTakeableBook(marketId: MarketId): Promise<TakeableBook>
}

export interface ResolverService {
  simulate(match: CrossedMatch): Promise<SimulationResult>
  submit(prepared: PreparedResolution, blockNumber: bigint): Promise<void>
}

interface BotLogger {
  info(event: string, fields: Record<string, unknown>): void
  warn(event: string, fields: Record<string, unknown>): void
}

export class CrossedBooksBotService {
  constructor(
    private readonly markets: ListedMarketsService,
    private readonly books: OrderBookService,
    private readonly matching: MatchingServicePort,
    private readonly resolver: ResolverService,
    private readonly inflightMarketIds: () => ReadonlySet<string>,
    private readonly logger: BotLogger
  ) {}

  async run({ blockNumber }: { blockNumber: bigint }) {
    const markets = await this.markets.listListedActiveMarkets()
    const inflight = this.inflightMarketIds()

    for (const { marketId } of markets) {
      if (inflight.has(marketId)) continue

      const book = await this._getBook(marketId)
      if (!book) continue

      const match = this.matching.match({ asks: book.asks, bids: book.bids, maxMatches: 1 })[0]
      if (!match) continue

      const simulation = await this.resolver.simulate(match)
      if (simulation.status === 'revert') {
        this.logger.info('match.not_profitable', {
          marketId,
          reason: simulation.reason
        })
        continue
      }

      await this.resolver.submit(simulation.prepared, blockNumber)
      this.logger.info('match.submitted', {
        marketId,
        units: match.units,
        profit: simulation.prepared.profit
      })

      return { submitted: true, markets: markets.length }
    }

    this.logger.info('tick.no_match', { markets: markets.length })
    return { submitted: false, markets: markets.length }
  }

  private async _getBook(marketId: Hex) {
    try {
      return await this.books.getTakeableBook(marketId)
    } catch (error) {
      this.logger.warn('books.fetch_failed', {
        marketId,
        reason: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }
}
