import { describe, expect, it } from 'vitest'

import { createMidnightClient } from '../../src/midnight/client'

function captureFetch(requests: Request[]) {
  return async (request: Request) => {
    requests.push(request)
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
}

describe('createMidnightClient', () => {
  it('sends x-api-key on every request when apiKey is set', async () => {
    const requests: Request[] = []
    const client = createMidnightClient('https://api.example.test', {
      fetchImpl: captureFetch(requests),
      apiKey: 'test-key'
    })

    await client.GET('/v0/midnight/markets', {
      params: { query: { active_only: 'true', limit: 1 } }
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('x-api-key')).toBe('test-key')
  })

  it('omits the header when apiKey is unset', async () => {
    const requests: Request[] = []
    const client = createMidnightClient('https://api.example.test', {
      fetchImpl: captureFetch(requests)
    })

    await client.GET('/v0/midnight/markets', {
      params: { query: { active_only: 'true', limit: 1 } }
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('x-api-key')).toBeNull()
  })
})
