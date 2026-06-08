import { describe, expect, it } from 'bun:test'

import type { MidnightApiClient } from '../../src/api/client'
import type { BorrowPosition } from '../../src/api/positions'

import { listBorrowPositions } from '../../src/api/positions'

// Only the fields the collection logic touches; the test exercises pagination, not field mapping.
function position(marketId: string): BorrowPosition {
  return { market_id: marketId } as unknown as BorrowPosition
}

describe('listBorrowPositions', () => {
  it('paginates across pages and collects every row until the cursor is null', async () => {
    const outcomes = [
      {
        data: { cursor: 'c1', data: [position('m1'), position('m2')] },
        response: new Response(null, { status: 200 })
      },
      {
        data: { cursor: null, data: [position('m3')] },
        response: new Response(null, { status: 200 })
      }
    ]
    let call = 0
    const client = {
      GET: async () => outcomes[Math.min(call++, outcomes.length - 1)]
    } as unknown as MidnightApiClient

    const result = await listBorrowPositions(client, { user: '0xuser', chainId: 8453 })
    expect(result.error).toBeNull()
    expect(result.data?.map(p => p.market_id)).toEqual(['m1', 'm2', 'm3'])
    expect(call).toBe(2) // stopped after the null-cursor page, no extra request
  })

  it('surfaces a typed api error', async () => {
    const client = {
      GET: async () => ({
        error: { error: { code: 'BAD_REQUEST', message: 'x', details: null, request_id: 'r' } },
        response: new Response(null, { status: 400 })
      })
    } as unknown as MidnightApiClient

    const result = await listBorrowPositions(client, { user: '0xuser', chainId: 8453 })
    expect(result.data).toBeNull()
    expect(result.error?.kind).toBe('api')
  })
})
