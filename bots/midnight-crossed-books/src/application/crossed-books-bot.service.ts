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
  simulate(matches: readonly CrossedMatch[]): Promise<SimulationResult>
  submit(prepared: PreparedResolution, blockNumber: bigint): Promise<void>
}

interface BotLogger {
  info(event: string, fields: Record<string, unknown>): void
  warn(event: string, fields: Record<string, unknown>): void
}

export class CrossedBooksBotService {
  /**
   * Creates one resolver workflow.
   * @param markets - Listed-market discovery port.
   * @param books - Takeable-book reader.
   * @param matching - Pure crossed-offer matcher.
   * @param resolver - Simulation and optional submission port.
   * @param maxMatches - Maximum matches encoded into one resolution.
   * @param inflightMarketIds - Current write-mode transaction labels.
   * @param readOnly - Whether successful simulations are logged instead of submitted.
   * @param logger - Structured operator logger.
   */
  constructor(
    private readonly markets: ListedMarketsService,
    private readonly books: OrderBookService,
    private readonly matching: MatchingServicePort,
    private readonly resolver: ResolverService,
    private readonly maxMatches: number,
    private readonly inflightMarketIds: () => ReadonlySet<string>,
    private readonly readOnly: boolean,
    private readonly logger: BotLogger
  ) {}

  /**
   * Computes the first profitable crossed resolution for one block.
   * @param blockNumber - Block label used only when queueing a write-mode transaction.
   * @returns Submission status and the number of listed markets inspected.
   * @remarks Always simulates first. Readonly mode logs `match.computed` and performs no submission.
   */
  async run({ blockNumber }: { blockNumber: bigint }) {
    const markets = await this.markets.listListedActiveMarkets()
    const inflight = this.inflightMarketIds()

    for (const { marketId } of markets) {
      if (inflight.has(marketId)) continue

      const book = await this._getBook(marketId)
      if (!book) continue

      const matches = this.matching.match({
        asks: book.asks,
        bids: book.bids,
        maxMatches: this.maxMatches
      })
      if (matches.length === 0) continue

      const simulation = await this.resolver.simulate(matches)
      if (simulation.status === 'revert') {
        this.logger.info('match.not_profitable', {
          marketId,
          reason: simulation.reason
        })
        continue
      }

      const fields = {
        marketId,
        units: matches.reduce((total, match) => total + match.units, 0n),
        profit: simulation.prepared.profit
      }
      if (this.readOnly) {
        this.logger.info('match.computed', fields)
        return { submitted: false, markets: markets.length }
      }

      await this.resolver.submit(simulation.prepared, blockNumber)
      this.logger.info('match.submitted', fields)

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
