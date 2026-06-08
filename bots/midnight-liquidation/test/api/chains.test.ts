import { describe, expect, it } from 'bun:test'

import type { ChainStatus } from '../../src/api/chains'
import type { MidnightApiClient } from '../../src/api/client'

import { getChainStatuses } from '../../src/api/chains'

function stubClient(outcome: unknown): MidnightApiClient {
  return { GET: async () => outcome } as unknown as MidnightApiClient
}

describe('getChainStatuses', () => {
  it('maps the chains response into ChainStatus[]', async () => {
    const client = stubClient({
      data: {
        data: [
          {
            chain_id: 8453,
            name: 'base',
            latest_indexed_block: { number: '47070034', hash: '0xabc' },
            activity_sync_status: { status: 'healthy', pipelines: [] }
          }
        ]
      },
      response: new Response(null, { status: 200 })
    })

    const result = await getChainStatuses(client)
    expect(result.error).toBeNull()
    const expected: ChainStatus[] = [{ chainId: 8453, name: 'base', latestIndexedBlock: 47070034n }]
    expect(result.data).toEqual(expected)
  })

  it('returns the api error on failure', async () => {
    const client = stubClient({
      error: {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'down', details: null, request_id: 'r' }
      },
      response: new Response(null, { status: 503 })
    })

    const result = await getChainStatuses(client)
    expect(result.data).toBeNull()
    expect(result.error?.kind).toBe('api')
  })
})
