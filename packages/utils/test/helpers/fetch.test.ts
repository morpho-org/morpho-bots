import { describe, expect, it } from 'bun:test'

import { fetchWithRetry, parseJsonResponse } from '../../src/helpers/fetch'

function mockResponse(body: string, status = 200): Response {
  return new Response(body, { status })
}

describe('parseJsonResponse', () => {
  it('should parse valid JSON', async () => {
    const response = mockResponse(JSON.stringify({ id: 1 }), 200)
    const result = await parseJsonResponse<{ id: number }>(response)

    expect(result).toEqual({ data: { id: 1 }, error: null })
  })

  it('should extract title from HTML error page', async () => {
    const html = '<html><head><title>502 Bad Gateway</title></head><body></body></html>'
    const response = mockResponse(html, 502)
    const result = await parseJsonResponse(response)

    expect(result.data).toBeNull()
    expect(result.error?.message).toBe('Upstream returned HTML (HTTP 502): 502 Bad Gateway')
  })

  it('should use body snippet when HTML has no title', async () => {
    const html = '<html><body><h1>Error</h1></body></html>'
    const response = mockResponse(html, 503)
    const result = await parseJsonResponse(response)

    expect(result.data).toBeNull()
    expect(result.error?.message).toContain('Upstream returned HTML (HTTP 503)')
    expect(result.error?.message).toContain('<html>')
  })

  it('should handle non-JSON, non-HTML response', async () => {
    const response = mockResponse('Internal server error', 500)
    const result = await parseJsonResponse(response)

    expect(result.data).toBeNull()
    expect(result.error?.message).toBe('Failed to parse response (HTTP 500): Internal server error')
  })

  it('should truncate long body snippets to 200 chars', async () => {
    const longText = 'x'.repeat(300)
    const response = mockResponse(longText, 500)
    const result = await parseJsonResponse(response)

    expect(result.data).toBeNull()
    expect(result.error?.message).toContain('x'.repeat(200))
    expect(result.error?.message).not.toContain('x'.repeat(201))
  })

  it('should handle HTML with whitespace before opening tag', async () => {
    const html = '  \n  <html><head><title>429 Too Many Requests</title></head></html>'
    const response = mockResponse(html, 429)
    const result = await parseJsonResponse(response)

    expect(result.data).toBeNull()
    expect(result.error?.message).toBe('Upstream returned HTML (HTTP 429): 429 Too Many Requests')
  })
})

describe('fetchWithRetry', () => {
  const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
    data: body,
    response: new Response(null, { status, headers })
  })

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
