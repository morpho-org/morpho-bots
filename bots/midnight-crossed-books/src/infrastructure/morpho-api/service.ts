import { isHex } from 'viem'

import type { ListedMarketsService } from '../../application/crossed-books-bot.service'
import type { ListedMarket, MarketId } from '../../domain/order-book'
import type { MorphoApiClient } from './client'
import type { paths } from './generated/morpho-api.types'

import { MorphoApiError } from '../openapi/error'
import { unwrapOpenApiResult, withOpenApiErrorBoundary } from '../openapi/result'

const MARKETS_ENDPOINT = '/v0/midnight/markets' as const satisfies keyof paths
const PAGE_SIZE = 100

function toMarketId(value: string): MarketId {
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`Invalid market id: ${value}`)
  }
  return value
}

export class MorphoApiService implements ListedMarketsService {
  constructor(
    private readonly client: MorphoApiClient,
    private readonly chainId: 8453
  ) {}

  listListedActiveMarkets(): Promise<ListedMarket[]> {
    return withOpenApiErrorBoundary(MARKETS_ENDPOINT, MorphoApiError, async () => {
      const markets: ListedMarket[] = []
      let cursor: string | undefined

      do {
        const result = await this.client.GET(MARKETS_ENDPOINT, {
          params: {
            query: {
              chain_ids: [this.chainId],
              listed: 'true',
              active_only: 'true',
              limit: PAGE_SIZE,
              cursor
            }
          }
        })
        const body = unwrapOpenApiResult(result, MARKETS_ENDPOINT, MorphoApiError)

        markets.push(...body.data.map(market => ({ marketId: toMarketId(market.market_id) })))
        cursor = body.cursor ?? undefined
      } while (cursor)

      return markets
    })
  }
}
