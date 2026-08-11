import { describe, expect, it } from 'vitest'

import { createRateLimitedClient } from '../src/http-client'
import { QuoteError } from '../src/types'

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
          ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
          : new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
      { maxRetries: 2 },
      sleeps
    )
    const json = await client.getJson<{ ok: boolean }>({ venue: '0x', url: 'https://x/y' })
    expect(json).toEqual({ ok: true })
    expect(calls).toBe(2)
    expect(sleeps).toContain(2000) // Retry-After: 2s
  })

  it('throws a rate_limited QuoteError after exhausting retries on 429', async () => {
    const client = fastClient(async () => new Response('no', { status: 429 }), { maxRetries: 1 })
    const reason = await client
      .getJson({ venue: '0x', url: 'https://x/y' })
      .then(() => 'resolved')
      .catch(e => (e instanceof QuoteError ? e.reason : 'other'))
    expect(reason).toBe('rate_limited')
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
})
