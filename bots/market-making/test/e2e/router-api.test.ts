import { describe, expect, test } from 'bun:test'

import { MARKET_ID } from './constants'
import { routerOfferDto } from './router-api'

describe('router offer-group fixture DTO', () => {
  test('includes the continuous fee cap required by production group parsing', () => {
    expect(
      routerOfferDto({
        maker: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        buy: true,
        tick: 6_744n,
        continuousFeeCap: 17n,
        market: { maturity: 1_785_510_000n }
      })
    ).toEqual({
      market_id: MARKET_ID,
      maker: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      buy: true,
      tick: 6_744,
      continuous_fee_cap: '17',
      market: { maturity: 1_785_510_000 }
    })
  })
})
