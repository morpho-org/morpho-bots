import type { Logger } from '@repo/bot-kit'
import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'

import { createListedMarketFilter } from '../../src/discovery/markets'

const API_URL = 'https://api.example/v0/midnight/markets'
const LISTED: Hex = `0x${'a'.repeat(64)}`
const UNLISTED: Hex = `0x${'b'.repeat(64)}`
const OTHER_CHAIN: Hex = `0x${'c'.repeat(64)}`
const LOAN = '0x6666666666666666666666666666666666666666'
const COLLATERAL = '0x7777777777777777777777777777777777777777'
const ORACLE = '0x8888888888888888888888888888888888888888'

const NOOP_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const market = (marketId: Hex, chainId = 8453) => ({
  chain_id: chainId,
  market_id: marketId,
  loan_token: LOAN,
  maturity: 0,
  collaterals: [
    { token: COLLATERAL, lltv: '860000000000000000', liquidation_cursor: '0', oracle: ORACLE }
  ]
})

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })

describe('createListedMarketFilter', () => {
  it('requests listed=true and whitelists only listed markets on the configured chain', async () => {
    let requested = ''
    const fetchImpl = async (request: Request) => {
      requested = request.url
      // Include an off-chain market to prove the chain filter drops it.
      return jsonResponse({ data: [market(LISTED), market(OTHER_CHAIN, 1)] })
    }
    const filter = createListedMarketFilter({
      apiUrl: API_URL,
      chainId: 8453,
      logger: NOOP_LOGGER,
      fetchImpl
    })
    await filter.refresh()

    expect(new URL(requested).pathname).toBe('/v0/midnight/markets')
    expect(new URL(requested).searchParams.get('listed')).toBe('true')
    expect(filter.isListed(LISTED)).toBe(true)
    expect(filter.isListed(OTHER_CHAIN)).toBe(false) // wrong chain
    expect(filter.isListed(UNLISTED)).toBe(false) // absent
    expect(filter.snapshot().markets).toBe(1)
  })

  it('matches market ids case-insensitively', async () => {
    const fetchImpl = async () => jsonResponse({ data: [market(LISTED)] })
    const filter = createListedMarketFilter({
      apiUrl: API_URL,
      chainId: 8453,
      logger: NOOP_LOGGER,
      fetchImpl
    })
    await filter.refresh()
    expect(filter.isListed(LISTED.toUpperCase() as Hex)).toBe(true)
  })

  it('is fail-closed before the first successful fetch (empty whitelist)', () => {
    const filter = createListedMarketFilter({
      apiUrl: API_URL,
      chainId: 8453,
      logger: NOOP_LOGGER,
      fetchImpl: async () => jsonResponse({ data: [] })
    })
    expect(filter.isListed(LISTED)).toBe(false)
    expect(filter.snapshot().updatedAt).toBeNull()
  })

  it('keeps last-known-good when a later refresh fails', async () => {
    let call = 0
    const fetchImpl = async () => {
      call += 1
      if (call === 1) return jsonResponse({ data: [market(LISTED)] })
      return jsonResponse({}, 500)
    }
    const filter = createListedMarketFilter({
      apiUrl: API_URL,
      chainId: 8453,
      logger: NOOP_LOGGER,
      fetchImpl,
      sleep: async () => {}
    })
    await filter.refresh()
    expect(filter.isListed(LISTED)).toBe(true)

    await expect(filter.refresh()).rejects.toThrow(/markets HTTP 500/)
    // Prior set survives the failed refresh.
    expect(filter.isListed(LISTED)).toBe(true)
  })

  it('surfaces updatedAt for the caller to gate whitelist staleness', async () => {
    const filter = createListedMarketFilter({
      apiUrl: API_URL,
      chainId: 8453,
      logger: NOOP_LOGGER,
      fetchImpl: async () => jsonResponse({ data: [market(LISTED)] }),
      now: () => 111
    })
    await filter.refresh()
    expect(filter.snapshot()).toEqual({ markets: 1, updatedAt: 111 })
  })

  it('retries a 429 honoring Retry-After', async () => {
    let attempts = 0
    const fetchImpl = async () => {
      attempts += 1
      if (attempts === 1) return jsonResponse({}, 429, { 'retry-after': '0' })
      return jsonResponse({ data: [market(LISTED)] })
    }
    const filter = createListedMarketFilter({
      apiUrl: API_URL,
      chainId: 8453,
      logger: NOOP_LOGGER,
      fetchImpl,
      sleep: async () => {}
    })
    await filter.refresh()
    expect(attempts).toBe(2)
    expect(filter.isListed(LISTED)).toBe(true)
  })
})
