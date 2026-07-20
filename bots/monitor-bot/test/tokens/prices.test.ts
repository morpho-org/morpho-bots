import { describe, expect, it, vi } from 'vitest'

import { TokenPriceCache } from '../../src/tokens/prices'
import { TokenRegistry } from '../../src/tokens/registry'
import { fakeLogger } from '../helpers'
import { MARKET_A, MARKET_B } from '../midnight/fixtures'

const TOKEN_A = '0x1111111111111111111111111111111111111111'
const TOKEN_B = '0x2222222222222222222222222222222222222222'

function market(id: string, loan: string, collaterals: string[] = []) {
  return {
    market_id: id,
    chain_id: 8453,
    loan_token: loan,
    maturity: 1_790_726_400,
    collaterals: collaterals.map(token => ({ token, lltv: '860000000000000000' }))
  }
}

function priceBody(price: number | null) {
  return { chain_id: 8453, address: TOKEN_A, price, provider: 'test' }
}

type GetInit = { params: { path: { 'token-selector': string } } }

/** Mocks the typed core client at the openapi-fetch boundary, like the metadata loader tests. */
function makeCache(respond: (selector: string) => unknown, ok = true) {
  const tokens = new TokenRegistry()
  const logger = fakeLogger()
  const GET = vi.fn((_path: string, init: GetInit) => {
    const selector = init.params.path['token-selector']
    if (!ok) return Promise.reject(new Error('price lookup failed: HTTP 404'))
    return Promise.resolve({ data: { data: respond(selector) }, response: new Response('{}') })
  })
  const cache = new TokenPriceCache({
    client: { GET } as never,
    logger,
    tokens,
    sleep: () => Promise.resolve()
  })
  return { cache, tokens, logger, fetchImpl: GET }
}

describe('TokenPriceCache', () => {
  it('prices every token the recorded markets reference, loan and collateral alike', async () => {
    const { cache, tokens, fetchImpl } = makeCache(selector =>
      priceBody(selector.includes(TOKEN_B) ? 3000 : 1)
    )
    tokens.record(market(MARKET_A, TOKEN_A, [TOKEN_B]))

    expect(await cache.refresh()).toBe(2)
    expect(cache.usd(8453, TOKEN_A)).toBe(1)
    expect(cache.usd(8453, TOKEN_B)).toBe(3000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('asks the price endpoint with the documented <chain_id>:<address> selector', async () => {
    const { cache, tokens, fetchImpl } = makeCache(() => priceBody(1))
    tokens.record(market(MARKET_A, TOKEN_A))
    await cache.refresh()
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/v0/tokens/{token-selector}/price')
    expect(fetchImpl.mock.calls[0]?.[1]?.params.path['token-selector']).toBe(`8453:${TOKEN_A}`)
  })

  it('resolves case-insensitively and dedupes a token shared across markets', async () => {
    const { cache, tokens, fetchImpl } = makeCache(() => priceBody(2))
    tokens.record(market(MARKET_A, TOKEN_A))
    tokens.record(market(MARKET_B, TOKEN_A))
    await cache.refresh()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(cache.usd(8453, TOKEN_A.toUpperCase().replace('0X', '0x'))).toBe(2)
  })

  it('refetches on every refresh — prices are volatile, unlike token identity', async () => {
    let spot = 100
    const { cache, tokens, fetchImpl } = makeCache(() => priceBody(spot))
    tokens.record(market(MARKET_A, TOKEN_A))
    await cache.refresh()
    expect(cache.usd(8453, TOKEN_A)).toBe(100)

    spot = 120
    await cache.refresh()
    expect(cache.usd(8453, TOKEN_A)).toBe(120)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('returns null for a token with no USD quote rather than storing a bogus figure', async () => {
    const { cache, tokens } = makeCache(() => priceBody(null))
    tokens.record(market(MARKET_A, TOKEN_A))
    expect(await cache.refresh()).toBe(0)
    expect(cache.usd(8453, TOKEN_A)).toBeNull()
  })

  it('keeps the previous price when a refresh fails, and warns when nothing resolves', async () => {
    let ok = true
    const { cache, tokens, logger, fetchImpl } = makeCache(() => priceBody(100))
    // Re-wire the mock to fail on demand while keeping the cache instance.
    fetchImpl.mockImplementation((_path: string, init: GetInit) => {
      if (!ok) return Promise.reject(new Error('boom'))
      const selector = init.params.path['token-selector']
      return Promise.resolve({
        data: { data: priceBody(selector ? 100 : null) },
        response: new Response('{}')
      })
    })
    tokens.record(market(MARKET_A, TOKEN_A))
    await cache.refresh()
    expect(cache.usd(8453, TOKEN_A)).toBe(100)

    ok = false
    expect(await cache.refresh()).toBe(0)
    // Stale beats blank: the last known price keeps serving while lookups fail.
    expect(cache.usd(8453, TOKEN_A)).toBe(100)
    expect(logger.warn).toHaveBeenCalledWith('prices.unresolved', { requested: 1, resolved: 0 })
  })

  it('makes no requests before any market is recorded', async () => {
    const { cache, fetchImpl } = makeCache(() => priceBody(1))
    expect(await cache.refresh()).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
