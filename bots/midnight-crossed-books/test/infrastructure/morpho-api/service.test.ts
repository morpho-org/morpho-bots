import { describe, expect, test, vi } from 'vitest'

import { MorphoApiService } from '../../../src/infrastructure/morpho-api/service'
import { TruncatedMarketListError } from '../../../src/infrastructure/morpho-api/truncated-market-list.error'
import { MorphoApiError } from '../../../src/infrastructure/openapi/error'
import { MARKET_ID, OTHER_MARKET_ID } from '../../fixtures/offers'

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('MorphoApiService', () => {
  test('requests only listed active markets on the configured chain', async () => {
    const GET = vi.fn(async () => ({
      data: { cursor: null, data: [{ market_id: MARKET_ID }] },
      response: response({})
    }))
    const service = new MorphoApiService({ GET } as never, 8453)

    await service.listListedActiveMarkets()

    expect(GET).toHaveBeenCalledWith('/v0/midnight/markets', {
      params: {
        query: {
          chain_ids: [8453],
          listed: 'true',
          active_only: 'true',
          limit: 100,
          cursor: undefined
        }
      }
    })
  })

  test('drains cursor pagination in order', async () => {
    const GET = vi.fn(
      async (_path: string, request: { params: { query: { cursor?: string } } }) => {
        if (!request.params.query.cursor) {
          return {
            data: { cursor: 'next', data: [{ market_id: MARKET_ID }] },
            response: response({})
          }
        }
        return {
          data: { cursor: null, data: [{ market_id: OTHER_MARKET_ID }] },
          response: response({})
        }
      }
    )
    const service = new MorphoApiService({ GET } as never, 8453)

    const markets = await service.listListedActiveMarkets()

    expect(markets).toEqual([{ marketId: MARKET_ID }, { marketId: OTHER_MARKET_ID }])
    expect(GET).toHaveBeenCalledTimes(2)
  })

  // An endpoint that never returns a null cursor would otherwise loop forever. Failing is deliberate:
  // resolving crossed books against a silently partial market list would skip real crossings.
  test('fails rather than returning a partial market list on a runaway cursor', async () => {
    const GET = vi.fn(async () => ({
      data: { cursor: 'next', data: [{ market_id: MARKET_ID }] },
      response: response({})
    }))
    const service = new MorphoApiService({ GET } as never, 8453)

    const error = await service.listListedActiveMarkets().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(MorphoApiError)
    expect((error as MorphoApiError).cause).toBeInstanceOf(TruncatedMarketListError)
    expect(GET).toHaveBeenCalledTimes(50)
  })

  test('wraps a non-success response in MorphoApiError', async () => {
    const GET = vi.fn(async () => ({
      error: { code: 'SERVICE_UNAVAILABLE' },
      response: response({}, 503)
    }))
    const service = new MorphoApiService({ GET } as never, 8453)

    await expect(service.listListedActiveMarkets()).rejects.toBeInstanceOf(MorphoApiError)
  })

  test('wraps a rejected fetch in MorphoApiError', async () => {
    const GET = vi.fn(async () => {
      throw new Error('network down')
    })
    const service = new MorphoApiService({ GET } as never, 8453)

    await expect(service.listListedActiveMarkets()).rejects.toBeInstanceOf(MorphoApiError)
  })
})
