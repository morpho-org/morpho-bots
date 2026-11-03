import type { Logger } from '@repo/kit'
import type { Address, Hex } from 'viem'

import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { FetchCandidatePage } from '../../src/discovery/borrowers'
import type { MarketParams } from '../../src/market'
import type { MarketParamsResolver } from '../../src/state/market-params'

import {
  createApiCandidateSource,
  discoverBorrowerIds,
  discoverCandidates,
  PAGE_LIMIT
} from '../../src/discovery/borrowers'
import { CandidatesApiRefusedError, CandidatesApiResponseError } from '../../src/errors'

const MARKET: Hex = `0x${'a'.repeat(64)}`
const MARKET_2: Hex = `0x${'b'.repeat(64)}`
const BORROWER = '0x1111111111111111111111111111111111111111'
const BORROWER_2 = '0x2222222222222222222222222222222222222222'
const URL = 'https://api.example/liquidation-bot/blue/liquidation-candidates'
const API_KEY = 'test-key'

// Minimal raw response row — discovery only reads market_id + borrower (params come from
// idToMarketParams and the lens re-reads all position state fresh onchain).
const row = (marketId: unknown, borrower: unknown) => ({ market_id: marketId, borrower })

const params = (loanToken: Address): MarketParams => ({
  loanToken,
  collateralToken: getAddress('0x4200000000000000000000000000000000000006'),
  oracle: getAddress('0x3333333333333333333333333333333333333333'),
  irm: getAddress('0x4444444444444444444444444444444444444444'),
  lltv: 860000000000000000n
})

function spyLogger() {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = []
  const make = (level: string) => (event: string, fields?: Record<string, unknown>) =>
    events.push({ level, event, fields })
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error')
  }
  return { logger, events }
}

describe('discoverBorrowerIds', () => {
  it('follows the cursor until it runs out, de-duping across pages', async () => {
    const { logger } = spyLogger()
    const cursors: (string | null)[] = []
    const fetchPage: FetchCandidatePage = async cursor => {
      cursors.push(cursor)
      if (cursor === null)
        return { data: [row(MARKET, BORROWER), row(MARKET, BORROWER)], cursor: 'c1' }
      return { data: [row(MARKET, BORROWER), row(MARKET_2, BORROWER_2)], cursor: null }
    }
    const { pairs, rawRows, malformed, complete } = await discoverBorrowerIds(fetchPage, { logger })
    expect(complete).toBe(true)
    expect(cursors).toEqual([null, 'c1'])
    expect(rawRows).toBe(4)
    expect(malformed).toBe(0)
    expect(pairs).toEqual([
      { marketId: MARKET, borrower: getAddress(BORROWER) },
      { marketId: MARKET_2, borrower: getAddress(BORROWER_2) }
    ])
  })

  it('lowercases market ids and checksums borrowers; malformed rows are counted, not fatal', async () => {
    const { logger } = spyLogger()
    const fetchPage: FetchCandidatePage = async () => ({
      data: [
        row(`0x${'A'.repeat(64)}`, BORROWER.toUpperCase().replace('0X', '0x')),
        row('0xdead', BORROWER), // not bytes32
        row(BORROWER, BORROWER), // 20-byte hex is not a market id
        row(MARKET_2, 'not-an-address'),
        { borrower: BORROWER },
        'not-an-object'
      ],
      cursor: null
    })
    const { pairs, malformed } = await discoverBorrowerIds(fetchPage, { logger })
    expect(pairs).toEqual([{ marketId: MARKET, borrower: getAddress(BORROWER) }])
    expect(malformed).toBe(5)
  })

  it('logs discover.max_pages loud at the runaway backstop instead of silently truncating', async () => {
    const { logger, events } = spyLogger()
    let calls = 0
    const fetchPage: FetchCandidatePage = async () => {
      calls += 1
      return { data: [row(MARKET, BORROWER)], cursor: 'forever' }
    }
    const { complete } = await discoverBorrowerIds(fetchPage, { logger, maxPages: 2 })
    expect(complete).toBe(false)
    expect(calls).toBe(2)
    const warn = events.find(e => e.event === 'discover.max_pages')
    expect(warn?.level).toBe('warn')
    expect(warn?.fields?.cap).toBe(2)
    expect(warn?.fields?.pages).toBe(2)
  })

  it('caps at maxCandidates and logs discover.oversized without fetching another page', async () => {
    const { logger, events } = spyLogger()
    const data = Array.from({ length: PAGE_LIMIT }, (_, i) =>
      row(MARKET, `0x${(i + 1).toString(16).padStart(40, '0')}`)
    )
    let calls = 0
    const fetchPage: FetchCandidatePage = async () => {
      calls += 1
      return { data, cursor: 'more' }
    }
    const { pairs, complete } = await discoverBorrowerIds(fetchPage, { logger, maxCandidates: 500 })
    expect(complete).toBe(false)
    expect(pairs).toHaveLength(500)
    expect(calls).toBe(1)
    const warn = events.find(e => e.event === 'discover.oversized')
    expect(warn?.level).toBe('warn')
    expect(warn?.fields?.cap).toBe(500)
    expect(warn?.fields?.collected).toBe(500)
  })
})

describe('discoverCandidates', () => {
  const resolver =
    (known: Partial<Record<Hex, MarketParams>>): MarketParamsResolver =>
    async ids => {
      const out = new Map<Hex, MarketParams>()
      for (const id of ids) {
        const p = known[id]
        if (p) out.set(id, p)
      }
      return out
    }

  it('joins pairs to onchain params and drops unresolved ids with a loud warn', async () => {
    const { logger, events } = spyLogger()
    const loan = getAddress('0x5555555555555555555555555555555555555555')
    const fetchPage: FetchCandidatePage = async () => ({
      data: [row(MARKET, BORROWER), row(MARKET_2, BORROWER_2)],
      cursor: null
    })
    const discovered = await discoverCandidates(fetchPage, resolver({ [MARKET]: params(loan) }), {
      logger
    })
    expect(discovered).toEqual({
      candidates: [{ marketParams: params(loan), borrower: getAddress(BORROWER) }],
      complete: true
    })
    const dropped = events.find(e => e.event === 'discover.dropped')
    expect(dropped?.level).toBe('warn')
    expect(dropped?.fields?.unresolvedMarkets).toBe(1)
    expect(dropped?.fields?.unresolvedSample).toEqual([MARKET_2])
  })

  it('is not complete when it could not read a row', async () => {
    const { logger } = spyLogger()
    const loan = getAddress('0x5555555555555555555555555555555555555555')
    const fetchPage: FetchCandidatePage = async () => ({
      data: [row(MARKET, BORROWER), row(MARKET, 'not-an-address')],
      cursor: null
    })
    const { complete } = await discoverCandidates(fetchPage, resolver({ [MARKET]: params(loan) }), {
      logger
    })
    expect(complete).toBe(false)
  })

  it('emits no drop warn on a clean pass', async () => {
    const { logger, events } = spyLogger()
    const loan = getAddress('0x5555555555555555555555555555555555555555')
    const fetchPage: FetchCandidatePage = async () => ({
      data: [row(MARKET, BORROWER)],
      cursor: null
    })
    await discoverCandidates(fetchPage, resolver({ [MARKET]: params(loan) }), { logger })
    expect(events.find(e => e.event === 'discover.dropped')).toBeUndefined()
    expect(events.find(e => e.event === 'discover.pass')?.fields?.candidates).toBe(1)
  })
})

describe('createApiCandidateSource', () => {
  const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers })
  const source = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>) =>
    createApiCandidateSource({
      url: URL,
      apiKey: API_KEY,
      chainId: 4663,
      healthFactorLte: 1.02,
      fetchImpl,
      sleep: async () => {}
    })

  it('GETs with chain/hf/limit/cursor params and the API key header, and parses the page', async () => {
    const requests: { url: string; init: RequestInit }[] = []
    const fetchPage = source(async (url, init) => {
      requests.push({ url, init })
      return jsonResponse({ data: [row(MARKET, BORROWER)], cursor: 'next' })
    })
    expect(await fetchPage(null)).toEqual({ data: [row(MARKET, BORROWER)], cursor: 'next' })
    await fetchPage('next')

    const first = new globalThis.URL(requests[0]?.url ?? '')
    expect(`${first.origin}${first.pathname}`).toBe(URL)
    expect(Object.fromEntries(first.searchParams)).toEqual({
      chain_ids: '4663',
      health_factor_lte: '1.02',
      limit: String(PAGE_LIMIT)
    })
    expect(new globalThis.URL(requests[1]?.url ?? '').searchParams.get('cursor')).toBe('next')
    expect(new Headers(requests[0]?.init.headers).get('x-api-key')).toBe(API_KEY)
    expect(requests[0]?.init.redirect).toBe('manual')
  })

  it('reads a null cursor as the last page', async () => {
    const fetchPage = source(async () => jsonResponse({ data: [], cursor: null }))
    expect((await fetchPage(null)).cursor).toBeNull()
  })

  it('retries a 429 (honoring Retry-After) then succeeds', async () => {
    let attempts = 0
    const fetchPage = source(async () => {
      attempts += 1
      return attempts === 1
        ? jsonResponse({}, 429, { 'retry-after': '0' })
        : jsonResponse({ data: [], cursor: null })
    })
    expect((await fetchPage(null)).data).toEqual([])
    expect(attempts).toBe(2)
  })

  it('still follows the HTTP retry policy when a 5xx body is not JSON', async () => {
    let attempts = 0
    const fetchPage = source(async () => {
      attempts += 1
      return attempts === 1
        ? new Response('<html>502 Bad Gateway</html>', { status: 502 })
        : jsonResponse({ data: [], cursor: null })
    })
    expect((await fetchPage(null)).data).toEqual([])
    expect(attempts).toBe(2)
  })

  it.each([401, 403])(
    'throws CandidatesApiRefusedError naming the key on a %i after one attempt, without the key or URL',
    async status => {
      let attempts = 0
      const fetchPage = source(async () => {
        attempts += 1
        return jsonResponse({ message: 'Forbidden' }, status)
      })
      const rejected = fetchPage(null)
      await expect(rejected).rejects.toBeInstanceOf(CandidatesApiRefusedError)
      await expect(rejected).rejects.toThrow(
        /^liquidation-candidates rejected the API key \(HTTP 40[13]\)$/
      )
      expect(attempts).toBe(1)
    }
  )

  it('does not read a retried 5xx that ends in a network error as a rejected key', async () => {
    let attempts = 0
    const fetchPage = source(async () => {
      attempts += 1
      if (attempts === 1) return jsonResponse({}, 503, { 'retry-after': '0' })
      throw new TypeError('fetch failed')
    })
    const rejected = fetchPage(null)
    await expect(rejected).rejects.toThrow(/^liquidation-candidates request failed/)
    await expect(rejected).rejects.not.toBeInstanceOf(CandidatesApiRefusedError)
  })

  it.each([400, 404])(
    'throws CandidatesApiRefusedError on a %i after one attempt, naming no URL',
    async status => {
      let attempts = 0
      const fetchPage = source(async () => {
        attempts += 1
        return jsonResponse({}, status)
      })
      const refused = fetchPage(null)
      await expect(refused).rejects.toBeInstanceOf(CandidatesApiRefusedError)
      await expect(refused).rejects.toThrow(
        /^liquidation-candidates refused the request \(HTTP 40[04]\)$/
      )
      expect(attempts).toBe(1)
    }
  )

  it('throws CandidatesApiRefusedError on a redirect after one attempt, without following it', async () => {
    let attempts = 0
    const fetchPage = source(async () => {
      attempts += 1
      return new Response(null, {
        status: 301,
        headers: { location: 'https://elsewhere.example/' }
      })
    })
    const refused = fetchPage(null)
    await expect(refused).rejects.toBeInstanceOf(CandidatesApiRefusedError)
    await expect(refused).rejects.toThrow(
      /^liquidation-candidates redirected the request \(HTTP 301\)$/
    )
    expect(attempts).toBe(1)
  })

  it('throws a 429 that outlasts its retries as a plain error', async () => {
    const fetchPage = source(async () => jsonResponse({}, 429, { 'retry-after': '0' }))
    const limited = fetchPage(null)
    await expect(limited).rejects.toThrow(/^liquidation-candidates HTTP 429$/)
    await expect(limited).rejects.not.toBeInstanceOf(CandidatesApiRefusedError)
  })

  it('throws a parse error when data is missing', async () => {
    const fetchPage = source(async () => jsonResponse({ cursor: null }))
    const failed = fetchPage(null)
    await expect(failed).rejects.toBeInstanceOf(CandidatesApiResponseError)
    await expect(failed).rejects.toThrow('parse error: missing data')
  })

  it('throws rather than reading a missing or empty cursor as the last page', async () => {
    const missing = source(async () => jsonResponse({ data: [] }))
    await expect(missing(null)).rejects.toThrow('parse error: missing cursor')
    const empty = source(async () => jsonResponse({ data: [], cursor: '' }))
    await expect(empty(null)).rejects.toThrow('parse error: empty cursor')
  })
})
