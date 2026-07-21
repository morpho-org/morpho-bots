import { describe, expect, mock, test } from 'bun:test'

import { MorphoApiError } from '../../../src/infrastructure/openapi/error'
import { MorphoApiService } from '../../../src/infrastructure/morpho-api/service'
import { MARKET_ID, OTHER_MARKET_ID } from '../../fixtures/offers'

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('MorphoApiService', () => {
  test('requests only listed active markets on the configured chain', async () => {
    const GET = mock(async () => ({
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
    const GET = mock(async (_path: string, request: { params: { query: { cursor?: string } } }) => {
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
    })
    const service = new MorphoApiService({ GET } as never, 8453)

    const markets = await service.listListedActiveMarkets()

    expect(markets).toEqual([{ marketId: MARKET_ID }, { marketId: OTHER_MARKET_ID }])
    expect(GET).toHaveBeenCalledTimes(2)
  })

  test('wraps a non-success response in MorphoApiError', async () => {
    const GET = mock(async () => ({
      error: { code: 'SERVICE_UNAVAILABLE' },
      response: response({}, 503)
    }))
    const service = new MorphoApiService({ GET } as never, 8453)

    await expect(service.listListedActiveMarkets()).rejects.toBeInstanceOf(MorphoApiError)
  })

  test('wraps a rejected fetch in MorphoApiError', async () => {
    const GET = mock(async () => {
      throw new Error('network down')
    })
    const service = new MorphoApiService({ GET } as never, 8453)

    await expect(service.listListedActiveMarkets()).rejects.toBeInstanceOf(MorphoApiError)
  })
})
