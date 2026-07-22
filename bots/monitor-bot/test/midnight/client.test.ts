import { describe, expect, it } from 'vitest'

import { createMidnightClient } from '../../src/midnight/client'
import { fakeLogger } from '../helpers'

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

  it('logs the Retry-After duration when a request returns 429', async () => {
    const logger = fakeLogger()
    const client = createMidnightClient('https://api.example.test', {
      fetchImpl: async () =>
        new Response('{}', { status: 429, headers: { 'retry-after': '604800' } }),
      logger
    })

    await client.GET('/v0/midnight/books', {
      params: { query: { limit: 1 } }
    })

    expect(logger.warn).toHaveBeenCalledWith('midnight.rate_limited', {
      method: 'GET',
      path: '/v0/midnight/books',
      retryAfter: '604800',
      retryAfterSeconds: 604_800,
      retryAfterDays: 7
    })
  })
})
