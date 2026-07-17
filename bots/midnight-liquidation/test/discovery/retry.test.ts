import { describe, expect, it } from 'bun:test'

import { fetchWithRetry } from '../../src/discovery/retry'

const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
  data: body,
  response: new Response(null, { status, headers })
})

describe('fetchWithRetry', () => {
  it('returns the parsed body on a 2xx response without sleeping', async () => {
    let slept = 0
    const body = await fetchWithRetry(async () => ok({ value: 1 }), {
      label: 'markets',
      sleep: async () => {
        slept += 1
      }
    })
    expect(body).toEqual({ value: 1 })
    expect(slept).toBe(0)
  })

  it('retries a 429 honoring Retry-After, then succeeds', async () => {
    let attempts = 0
    let slept = 0
    const body = await fetchWithRetry(
      async () => {
        attempts += 1
        return attempts === 1 ? ok({}, 429, { 'retry-after': '0' }) : ok({ value: 2 })
      },
      {
        label: 'markets',
        sleep: async () => {
          slept += 1
        }
      }
    )
    expect(attempts).toBe(2)
    expect(slept).toBe(1)
    expect(body).toEqual({ value: 2 })
  })

  it('retries a network-error throw, then succeeds', async () => {
    let attempts = 0
    const body = await fetchWithRetry(
      async () => {
        attempts += 1
        if (attempts === 1) throw new Error('socket hang up')
        return ok({ value: 3 })
      },
      { label: 'markets', sleep: async () => {} }
    )
    expect(attempts).toBe(2)
    expect(body).toEqual({ value: 3 })
  })

  it('labels a network-error throw after exhausting retries', async () => {
    let attempts = 0
    await expect(
      fetchWithRetry(
        async () => {
          attempts += 1
          throw new Error('socket hang up')
        },
        { label: 'liquidation-candidates', sleep: async () => {}, maxRetries: 2 }
      )
    ).rejects.toThrow('liquidation-candidates request failed: socket hang up')
    // Initial attempt + maxRetries retries.
    expect(attempts).toBe(3)
  })

  it('labels a persistent 5xx after exhausting retries', async () => {
    await expect(
      fetchWithRetry(async () => ok({}, 500), {
        label: 'markets',
        sleep: async () => {},
        maxRetries: 1
      })
    ).rejects.toThrow('markets HTTP 500')
  })

  it('throws immediately on a non-retryable 4xx (no sleep)', async () => {
    let slept = 0
    let attempts = 0
    await expect(
      fetchWithRetry(
        async () => {
          attempts += 1
          return ok({}, 400)
        },
        {
          label: 'liquidation-candidates',
          sleep: async () => {
            slept += 1
          }
        }
      )
    ).rejects.toThrow('liquidation-candidates HTTP 400')
    expect(attempts).toBe(1)
    expect(slept).toBe(0)
  })

  it('throws a labeled parse error when a 2xx response has an empty body', async () => {
    await expect(
      fetchWithRetry(async () => ok(undefined), { label: 'markets', sleep: async () => {} })
    ).rejects.toThrow('markets parse error: empty body')
  })
})
