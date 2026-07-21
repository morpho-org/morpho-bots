import { describe, expect, it, vi } from 'vitest'

import { createMidnightClient, MIN_REQUEST_INTERVAL_MS } from '../../src/midnight/client'
import { MidnightRateLimitError } from '../../src/midnight/retry'
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

  it('paces concurrent requests below the upstream per-minute limit', async () => {
    let now = 0
    const starts: number[] = []
    const waits: number[] = []
    const client = createMidnightClient('https://api.example.test', {
      fetchImpl: async () => {
        starts.push(now)
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      },
      requestIntervalMs: MIN_REQUEST_INTERVAL_MS,
      now: () => now,
      sleep: async ms => {
        waits.push(ms)
        now += ms
      }
    })

    await Promise.all([
      client.GET('/v0/midnight/markets', {
        params: { query: { active_only: 'true', limit: 1 } }
      }),
      client.GET('/v0/midnight/books', { params: { query: { limit: 1 } } }),
      client.GET('/v0/midnight/markets', {
        params: { query: { active_only: 'true', limit: 1 } }
      })
    ])

    expect(starts).toEqual([0, 240, 480])
    expect(waits).toEqual([240, 240])
  })

  it('opens a shared cooldown on 429 and blocks requests locally until Retry-After', async () => {
    let now = 1_000
    const fetchImpl = vi
      .fn<(_: Request) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '600' } }))
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    const logger = fakeLogger()
    const client = createMidnightClient('https://api.example.test', {
      fetchImpl,
      logger,
      requestIntervalMs: 0,
      now: () => now
    })

    const request = () => client.GET('/v0/midnight/books', { params: { query: { limit: 1 } } })

    await expect(request()).rejects.toBeInstanceOf(MidnightRateLimitError)
    await expect(request()).rejects.toBeInstanceOf(MidnightRateLimitError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('midnight.rate_limited', {
      method: 'GET',
      path: '/v0/midnight/books',
      retryAfterMs: 600_000,
      retryAt: '1970-01-01T00:10:01.000Z'
    })

    now += 600_000
    await expect(request()).resolves.toMatchObject({ data: { data: [] } })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
