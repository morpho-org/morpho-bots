import { describe, expect, it } from 'vitest'

import { QuoteError } from '../src/errors'
import { createRateLimitedClient } from '../src/http-client'

const fastClient = (
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: { maxRetries?: number; apiKeys?: Record<string, string> } = {},
  sleeps?: number[]
) =>
  createRateLimitedClient({
    apiKeys: overrides.apiKeys ?? {},
    rps: 1_000_000,
    burst: 1_000_000,
    maxRetries: overrides.maxRetries ?? 2,
    timeoutMs: 1000,
    fetchImpl,
    now: () => 0,
    sleep: async ms => {
      sleeps?.push(ms)
    }
  })

describe('createRateLimitedClient', () => {
  it('injects the 0x api key + version headers and parses JSON', async () => {
    let captured: { url: string; headers: Record<string, string> } | undefined
    const client = fastClient(
      async (url, init) => {
        captured = { url, headers: init?.headers as Record<string, string> }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
      { apiKeys: { '0x': 'KEY' } }
    )
    const json = await client.getJson<{ ok: boolean }>({
      venue: '0x',
      url: 'https://api.0x.org/swap/allowance-holder/quote',
      searchParams: { chainId: '8453' }
    })
    expect(json).toEqual({ ok: true })
    expect(captured?.headers['0x-api-key']).toBe('KEY')
    expect(captured?.headers['0x-version']).toBe('v2')
    expect(captured?.url).toContain('chainId=8453')
  })

  it('injects the 1inch bearer token', async () => {
    let headers: Record<string, string> | undefined
    const client = fastClient(
      async (_url, init) => {
        headers = init?.headers as Record<string, string>
        return new Response('{}', { status: 200 })
      },
      { apiKeys: { '1inch': 'TOK' } }
    )
    await client.getJson({ venue: '1inch', url: 'https://api.1inch.dev/swap' })
    expect(headers?.Authorization).toBe('Bearer TOK')
  })

  it('injects the LiFi api key header when a key is configured', async () => {
    let headers: Record<string, string> | undefined
    const client = fastClient(
      async (_url, init) => {
        headers = init?.headers as Record<string, string>
        return new Response('{}', { status: 200 })
      },
      { apiKeys: { lifi: 'LK' } }
    )
    await client.getJson({ venue: 'lifi', url: 'https://li.quest/v1/quote' })
    expect(headers?.['x-lifi-api-key']).toBe('LK')
  })

  it('omits the LiFi api key header entirely when keyless (LiFi 401s on an empty key)', async () => {
    let headers: Record<string, string> | undefined
    const client = fastClient(async (_url, init) => {
      headers = init?.headers as Record<string, string>
      return new Response('{}', { status: 200 })
    }) // no apiKeys
    await client.getJson({ venue: 'lifi', url: 'https://li.quest/v1/quote' })
    expect(headers && 'x-lifi-api-key' in headers).toBe(false)
  })

  it('serves pendle (an unwrapper host, not a Venue) keyless with no auth headers', async () => {
    let headers: Record<string, string> | undefined
    const client = fastClient(async (_url, init) => {
      headers = init?.headers as Record<string, string>
      return new Response('{}', { status: 200 })
    })
    await client.getJson({ venue: 'pendle', url: 'https://api-v2.pendle.finance/core/v1/chains' })
    expect(headers).toEqual({})
  })

  it('retries a 429 honoring Retry-After, then succeeds', async () => {
    let calls = 0
    const sleeps: number[] = []
    const client = fastClient(
      async () => {
        calls += 1
        return calls === 1
          ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } })
          : new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
      { maxRetries: 2 },
      sleeps
    )
    const json = await client.getJson<{ ok: boolean }>({ venue: '0x', url: 'https://x/y' })
    expect(json).toEqual({ ok: true })
    expect(calls).toBe(2)
    expect(sleeps).toContain(1000) // Retry-After: 1s
  })

  it('throws a rate_limited QuoteError after exhausting retries on 429', async () => {
    const client = fastClient(async () => new Response('no', { status: 429 }), { maxRetries: 1 })
    const reason = await client
      .getJson({ venue: '0x', url: 'https://x/y' })
      .then(() => 'resolved')
      .catch(e => (e instanceof QuoteError ? e.reason : 'other'))
    expect(reason).toBe('rate_limited')
  })

  it('fails rate_limited at once when Retry-After outlasts the request deadline', async () => {
    let calls = 0
    const sleeps: number[] = []
    const client = fastClient(
      async () => {
        calls += 1
        return new Response('quota', { status: 429, headers: { 'retry-after': '7200' } })
      },
      { maxRetries: 2 },
      sleeps
    )
    const reason = await client
      .getJson({ venue: 'lifi', url: 'https://x/y' })
      .catch(e => (e instanceof QuoteError ? e.reason : 'other'))
    expect(reason).toBe('rate_limited')
    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('asks a venue nothing more until the Retry-After of its last 429 passes', async () => {
    let at = 0
    const statuses: number[] = []
    const client = createRateLimitedClient({
      apiKeys: {},
      rps: 1_000_000,
      burst: 1_000_000,
      maxRetries: 0,
      timeoutMs: 1000,
      fetchImpl: async () => {
        const status = statuses.length === 0 ? 429 : 200
        statuses.push(status)
        return new Response('{}', { status, headers: { 'retry-after': '30' } })
      },
      now: () => at,
      sleep: async () => {}
    })
    const reasonOf = (venue: 'lifi' | '0x') =>
      client
        .getJson({ venue, url: 'https://x/y' })
        .then(() => 'ok')
        .catch(e => (e instanceof QuoteError ? e.reason : 'other'))
    expect(await reasonOf('lifi')).toBe('rate_limited')
    at = 29_999
    expect(await reasonOf('lifi')).toBe('rate_limited')
    expect(await reasonOf('0x')).toBe('ok')
    at = 30_000
    expect(await reasonOf('lifi')).toBe('ok')
    expect(statuses).toEqual([429, 200, 200])
    expect(client.requests?.()).toBe(3)
  })

  it('keeps the longer cooldown when concurrent 429s disagree on Retry-After', async () => {
    let at = 0
    const pending: ((retryAfter: string) => void)[] = []
    const client = createRateLimitedClient({
      apiKeys: {},
      rps: 1_000_000,
      burst: 1_000_000,
      maxRetries: 0,
      timeoutMs: 1000,
      fetchImpl: async () => {
        if (pending.length === 2) return new Response('{}', { status: 200 })
        const retryAfter = await new Promise<string>(resolve => pending.push(resolve))
        return new Response('{}', { status: 429, headers: { 'retry-after': retryAfter } })
      },
      now: () => at,
      sleep: async () => {}
    })
    const reasonOf = () =>
      client
        .getJson({ venue: 'lifi', url: 'https://x/y' })
        .then(() => 'ok')
        .catch(e => (e instanceof QuoteError ? e.reason : 'other'))
    const long = reasonOf()
    const short = reasonOf()
    await new Promise(resolve => setImmediate(resolve))
    pending[0]?.('60')
    expect(await long).toBe('rate_limited')
    pending[1]?.('5')
    expect(await short).toBe('rate_limited')
    at = 59_999
    expect(await reasonOf()).toBe('rate_limited')
    at = 60_000
    expect(await reasonOf()).toBe('ok')
  })

  it('refuses a cooling venue without waiting for its rate limit', async () => {
    const client = createRateLimitedClient({
      apiKeys: {},
      rps: 1e-9,
      burst: 1,
      maxRetries: 0,
      timeoutMs: 1000,
      fetchImpl: async () => new Response('{}', { status: 429 }),
      now: () => 0,
      sleep: () => new Promise<void>(() => {})
    })
    const reasonOf = () =>
      client
        .getJson({ venue: 'lifi', url: 'https://x/y' })
        .catch(e => (e instanceof QuoteError ? e.reason : 'other'))
    expect(await reasonOf()).toBe('rate_limited')
    expect(await reasonOf()).toBe('rate_limited')
  })

  it('sends nothing more from a call that was retrying when its venue started cooling down', async () => {
    let calls = 0
    let release = () => {}
    const blocked = new Promise<void>(resolve => (release = resolve))
    const client = createRateLimitedClient({
      apiKeys: {},
      rps: 1_000_000,
      burst: 1_000_000,
      maxRetries: 1,
      timeoutMs: 1000,
      fetchImpl: async () => {
        calls += 1
        const retryAfter = calls === 1 ? '1' : '7200'
        return new Response('{}', { status: 429, headers: { 'retry-after': retryAfter } })
      },
      now: () => 0,
      sleep: () => blocked
    })
    const reasonOf = () =>
      client
        .getJson({ venue: 'lifi', url: 'https://x/y' })
        .catch(e => (e instanceof QuoteError ? e.reason : 'other'))
    const retrying = reasonOf()
    await new Promise(resolve => setImmediate(resolve))
    expect(await reasonOf()).toBe('rate_limited')
    release()
    expect(await retrying).toBe('rate_limited')
    expect(calls).toBe(2)
  })

  it('fails api_error at once on a 503 whose Retry-After outlasts the request deadline', async () => {
    let calls = 0
    const sleeps: number[] = []
    const client = fastClient(
      async () => {
        calls += 1
        return new Response('maintenance', { status: 503, headers: { 'retry-after': '600' } })
      },
      { maxRetries: 2 },
      sleeps
    )
    const reason = await client
      .getJson({ venue: '1inch', url: 'https://x/y' })
      .catch(e => (e instanceof QuoteError ? e.reason : 'other'))
    expect(reason).toBe('api_error')
    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('throws a no_route QuoteError on a non-429 4xx without retrying', async () => {
    let calls = 0
    const client = fastClient(
      async () => {
        calls += 1
        return new Response('bad request', { status: 400 })
      },
      { maxRetries: 3 }
    )
    const reason = await client
      .getJson({ venue: '1inch', url: 'https://x/y' })
      .catch(e => (e instanceof QuoteError ? e.reason : 'other'))
    expect(reason).toBe('no_route')
    expect(calls).toBe(1) // 4xx is not retried
  })

  it('surfaces a non-JSON (HTML) body as an actionable api_error', async () => {
    const client = fastClient(
      async () => new Response('<html><title>Oops</title></html>', { status: 200 }),
      { maxRetries: 0 }
    )
    const err = await client
      .getJson({ venue: '0x', url: 'https://x/y' })
      .then(() => null)
      .catch(e => e as QuoteError)
    expect(err).toBeInstanceOf(QuoteError)
    expect(err?.reason).toBe('api_error')
    expect(err?.message).toContain('HTML')
  })

  it.each([403, 503])(
    'names only the venue, status and path of a failed HTTP %i, never the host, query or key',
    async status => {
      const client = fastClient(async () => new Response('secret-bearing body', { status }), {
        maxRetries: 0,
        apiKeys: { '1inch': 'SECRET-KEY' }
      })
      const err = await client
        .getJson({
          venue: '1inch',
          url: 'https://user:pw@api.1inch.test/swap/v6.0/8453/quote',
          searchParams: { src: '0xabc', apiKey: 'SECRET-QUERY' }
        })
        .catch(e => e as QuoteError)
      expect(err).toBeInstanceOf(QuoteError)
      expect((err as QuoteError).message).toBe(`1inch HTTP ${status} (/swap/v6.0/8453/quote)`)
    }
  )
})
