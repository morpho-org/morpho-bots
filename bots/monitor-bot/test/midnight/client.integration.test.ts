import { describe, expect, it } from 'vitest'

import { createMidnightClient } from '../../src/midnight/client'

// Live-API smoke test — opt-in only (MONITOR_LIVE_TESTS=1) so CI stays hermetic.
describe.skipIf(!process.env.MONITOR_LIVE_TESTS)('midnight api (live)', () => {
  it('lists markets and pages transactions for one of them', { timeout: 30_000 }, async () => {
    const client = createMidnightClient('https://api.morpho.org')

    const markets = await client.GET('/v0/midnight/markets', {
      params: { query: { active_only: 'true', limit: 3 } }
    })
    expect(markets.response.status).toBe(200)
    const first = markets.data?.data[0]
    expect(first?.market_id).toMatch(/^0x[0-9a-fA-F]{64}$/)
    if (!first) return

    const transactions = await client.GET('/v0/midnight/markets/{market-id}/transactions', {
      params: {
        path: { 'market-id': first.market_id },
        query: { sort_direction: 'asc', limit: 5 }
      }
    })
    expect(transactions.response.status).toBe(200)
    expect(Array.isArray(transactions.data?.data)).toBe(true)
    for (const item of transactions.data?.data ?? []) {
      expect(item.id).toBeTruthy()
      expect(typeof item.created_at).toBe('number')
    }
  })
})
