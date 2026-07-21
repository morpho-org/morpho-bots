import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import { createMidnightApi } from '../src/api'

const MARKET_ID = `0x${'11'.repeat(32)}` as const
const OTHER_MARKET_ID = `0x${'22'.repeat(32)}` as const

function row(marketId: string) {
  return {
    market_id: marketId,
    units: '10',
    ratifier_data: '0x',
    offer: {
      market: {
        chain_id: 8453,
        midnight: `0x${'33'.repeat(20)}`,
        loan_token: `0x${'44'.repeat(20)}`,
        collaterals: [],
        maturity: 2_000_000_000,
        rcf_threshold: '0',
        enter_gate: `0x${'00'.repeat(20)}`,
        liquidator_gate: `0x${'00'.repeat(20)}`
      },
      buy: false,
      maker: `0x${'55'.repeat(20)}`,
      start: 0,
      expiry: 2_000_000_000,
      tick: 1,
      group: `0x${'66'.repeat(32)}`,
      callback: `0x${'00'.repeat(20)}`,
      callback_data: '0x',
      receiver_if_maker_is_seller: `0x${'55'.repeat(20)}`,
      ratifier: `0x${'77'.repeat(20)}`,
      reduce_only: false,
      max_units: '10',
      max_assets: '0',
      continuous_fee_cap: '1'
    }
  }
}

afterEach(() => {
  ;(globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.()
})

describe('createMidnightApi', () => {
  test('keeps only offers for the requested market', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [row(MARKET_ID), row(OTHER_MARKET_ID)] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )

    const offers = await createMidnightApi('https://api.example', 8453).listSide(MARKET_ID, 'asks')

    expect(offers.map(offer => offer.marketId)).toEqual([MARKET_ID])
  })
})
