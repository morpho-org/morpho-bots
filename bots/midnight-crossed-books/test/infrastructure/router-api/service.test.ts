import { describe, expect, test, vi } from 'vitest'

import { RouterApiError } from '../../../src/infrastructure/openapi/error'
import { RouterApiService } from '../../../src/infrastructure/router-api/service'
import { MARKET_ID, OTHER_MARKET_ID } from '../../fixtures/offers'

const ZERO_ADDRESS = `0x${'00'.repeat(20)}`

function wireOffer(marketId: string, buy: boolean, units = '10') {
  return {
    market_id: marketId,
    units,
    ratifier_data: '0x',
    offer: {
      market: {
        chain_id: 8453,
        midnight: `0x${'33'.repeat(20)}`,
        loan_token: `0x${'44'.repeat(20)}`,
        collaterals: [],
        maturity: 2_000_000_000,
        rcf_threshold: '0',
        enter_gate: ZERO_ADDRESS,
        liquidator_gate: ZERO_ADDRESS
      },
      buy,
      maker: `0x${'55'.repeat(20)}`,
      start: 0,
      expiry: 2_000_000_000,
      tick: 7,
      group: `0x${'66'.repeat(32)}`,
      callback: ZERO_ADDRESS,
      callback_data: '0x',
      receiver_if_maker_is_seller: buy ? ZERO_ADDRESS : `0x${'55'.repeat(20)}`,
      ratifier: `0x${'77'.repeat(20)}`,
      reduce_only: false,
      max_units: '10',
      max_assets: '0',
      continuous_fee_cap: '1'
    }
  }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('RouterApiService', () => {
  test('requests asks and bids concurrently through typed paths', async () => {
    const GET = vi.fn(async (_path: string, request: { params: { path: { side: string } } }) => ({
      data: { data: [wireOffer(MARKET_ID, request.params.path.side === 'bids')] },
      response: response({})
    }))
    const service = new RouterApiService({ GET } as never)

    await service.getTakeableBook(MARKET_ID)

    expect(GET).toHaveBeenCalledTimes(2)
    expect(GET).toHaveBeenCalledWith('/v0/midnight/books/{market-id}/{side}/takeable-offers', {
      params: { path: { 'market-id': MARKET_ID, side: 'asks' } }
    })
    expect(GET).toHaveBeenCalledWith('/v0/midnight/books/{market-id}/{side}/takeable-offers', {
      params: { path: { 'market-id': MARKET_ID, side: 'bids' } }
    })
  })

  test('maps generated snake-case offer fields to the domain model', async () => {
    const GET = vi.fn(async (_path: string, request: { params: { path: { side: string } } }) => ({
      data: { data: [wireOffer(MARKET_ID, request.params.path.side === 'bids')] },
      response: response({})
    }))
    const service = new RouterApiService({ GET } as never)

    const book = await service.getTakeableBook(MARKET_ID)

    expect(book.asks[0]).toMatchObject({
      marketId: MARKET_ID,
      units: 10n,
      offer: {
        buy: false,
        tick: 7n,
        maxUnits: 10n,
        market: { chainId: 8453n, rcfThreshold: 0n }
      }
    })
    expect(book.bids[0]?.offer.buy).toBe(true)
  })

  test('drops zero-sized and wrong-market rows', async () => {
    const GET = vi.fn(async (_path: string, request: { params: { path: { side: string } } }) => ({
      data: {
        data: [
          wireOffer(MARKET_ID, request.params.path.side === 'bids'),
          wireOffer(MARKET_ID, request.params.path.side === 'bids', '0'),
          wireOffer(OTHER_MARKET_ID, request.params.path.side === 'bids')
        ]
      },
      response: response({})
    }))
    const service = new RouterApiService({ GET } as never)

    const book = await service.getTakeableBook(MARKET_ID)

    expect(book.asks).toHaveLength(1)
    expect(book.bids).toHaveLength(1)
  })

  test('wraps one-side HTTP failures as RouterApiError', async () => {
    const GET = vi.fn(async (_path: string, request: { params: { path: { side: string } } }) =>
      request.params.path.side === 'asks'
        ? { error: { code: 'SERVICE_UNAVAILABLE' }, response: response({}, 503) }
        : { data: { data: [] }, response: response({}) }
    )
    const service = new RouterApiService({ GET } as never)

    await expect(service.getTakeableBook(MARKET_ID)).rejects.toBeInstanceOf(RouterApiError)
  })

  test('wraps rejected requests as RouterApiError', async () => {
    const GET = vi.fn(async () => {
      throw new Error('timeout')
    })
    const service = new RouterApiService({ GET } as never)

    await expect(service.getTakeableBook(MARKET_ID)).rejects.toBeInstanceOf(RouterApiError)
  })
})
