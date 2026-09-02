import type { FetchPage } from '@repo/utils'

import { collectPages } from '@repo/utils'
import { isHex } from 'viem'

import type { ListedMarketsService } from '../../application/crossed-books-bot.service'
import type { ListedMarket, MarketId } from '../../domain/order-book'
import type { MorphoApiClient } from './client'
import type { paths } from './generated/morpho-api.types'

import { MorphoApiError } from '../openapi/error'
import { unwrapOpenApiResult, withOpenApiErrorBoundary } from '../openapi/result'
import { TruncatedMarketListError } from './truncated-market-list.error'

const MARKETS_ENDPOINT = '/v0/midnight/markets' as const satisfies keyof paths
const PAGE_SIZE = 100

/**
 * Runaway-cursor backstop, NOT an expected limit — at {@link PAGE_SIZE} rows a page this is 5,000
 * markets against a listed set of a handful. See {@link TruncatedMarketListError} for why hitting it
 * fails the fetch rather than returning what it has.
 */
const MAX_MARKET_PAGES = 50

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
      const fetchPage: FetchPage<{ market_id: string }> = async cursor => {
        const result = await this.client.GET(MARKETS_ENDPOINT, {
          params: {
            query: {
              chain_ids: [this.chainId],
              listed: 'true',
              active_only: 'true',
              limit: PAGE_SIZE,
              cursor: cursor ?? undefined
            }
          }
        })
        const body = unwrapOpenApiResult(result, MARKETS_ENDPOINT, MorphoApiError)
        return { cursor: body.cursor ?? null, data: body.data }
      }

      const { rows, pages, truncated } = await collectPages(fetchPage, {
        maxPages: MAX_MARKET_PAGES
      })
      if (truncated) throw new TruncatedMarketListError(pages)

      return rows.map(market => ({ marketId: toMarketId(market.market_id) }))
    })
  }
}
