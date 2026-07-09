import type { Logger } from '@repo/bot-kit'
import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { CandidatePage, FetchCandidatePage } from '../../src/discovery/borrowers'

import {
  buildCandidatesUrl,
  createApiCandidateSource,
  discoverBorrowers
} from '../../src/discovery/borrowers'

const MARKET: Hex = `0x${'a'.repeat(64)}`
const MARKET_2: Hex = `0x${'b'.repeat(64)}`
const BORROWER = '0x1111111111111111111111111111111111111111'
const BORROWER_2 = '0x2222222222222222222222222222222222222222'
const BASE_URL = 'https://api.example/markets/midnight/liquidation-candidates'

// Minimal raw response row — discovery only reads market_id + borrower (the lens re-derives the rest).
const row = (marketId: unknown, borrower: unknown) => ({
  chain_id: 8453,
  market_id: marketId,
  borrower,
  health_factor: 1.01,
  debt: '1',
  max_debt: '1',
  maturity: 0,
  at_risk_reasons: ['health_factor']
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

describe('buildCandidatesUrl', () => {
  it('assembles chain_ids, health_factor_lte, include_matured, and limit; omits cursor on page 1', () => {
    const url = new URL(
      buildCandidatesUrl({ baseUrl: BASE_URL, chainId: 8453, healthFactorLte: 1.02 })
    )
    expect(url.searchParams.get('chain_ids')).toBe('8453')
    expect(url.searchParams.get('health_factor_lte')).toBe('1.02')
    expect(url.searchParams.get('include_matured')).toBe('true')
    expect(url.searchParams.get('limit')).toBe('100')
    expect(url.searchParams.has('cursor')).toBe(false)
  })

  it('includes the cursor when provided and honors a custom limit', () => {
    const url = new URL(
      buildCandidatesUrl({
        baseUrl: BASE_URL,
        chainId: 8453,
        healthFactorLte: 1.02,
        limit: 20,
        cursor: 'abc'
      })
    )
    expect(url.searchParams.get('cursor')).toBe('abc')
    expect(url.searchParams.get('limit')).toBe('20')
  })
})

describe('discoverBorrowers', () => {
  it('follows the cursor across pages and returns validated, checksummed candidates', async () => {
    const { logger } = spyLogger()
    let calls = 0
    const fetchPage: FetchCandidatePage = async cursor => {
      calls += 1
      if (cursor === null) return { cursor: 'c1', data: [row(MARKET, BORROWER)] }
      return { cursor: null, data: [row(MARKET_2, BORROWER_2)] }
    }
    expect(await discoverBorrowers(fetchPage, { logger })).toEqual([
      { marketId: MARKET, borrower: getAddress(BORROWER) },
      { marketId: MARKET_2, borrower: getAddress(BORROWER_2) }
    ])
    expect(calls).toBe(2)
  })

  it('skips rows with a malformed market id or borrower address', async () => {
    const { logger } = spyLogger()
    const fetchPage: FetchCandidatePage = async () => ({
      cursor: null,
      data: [
        row(MARKET, BORROWER), // ok
        row('not-hex', BORROWER), // bad id
        row(MARKET, 'not-an-address'), // bad address
        row(null, BORROWER), // missing id
        'not-an-object' // wrong shape
      ]
    })
    expect(await discoverBorrowers(fetchPage, { logger })).toEqual([
      { marketId: MARKET, borrower: getAddress(BORROWER) }
    ])
  })

  it('de-duplicates a (market, borrower) pair seen across pages', async () => {
    const { logger } = spyLogger()
    const fetchPage: FetchCandidatePage = async cursor =>
      cursor === null
        ? { cursor: 'c1', data: [row(MARKET, BORROWER)] }
        : { cursor: null, data: [row(MARKET, BORROWER)] } // same pair again
    expect(await discoverBorrowers(fetchPage, { logger })).toEqual([
      { marketId: MARKET, borrower: getAddress(BORROWER) }
    ])
  })

  it('stops and warns discover.max_pages when the page cap is hit (never truncates silently)', async () => {
    const { logger, events } = spyLogger()
    let calls = 0
    // Always returns a non-null cursor — an endpoint that would page forever.
    const fetchPage: FetchCandidatePage = async () => {
      calls += 1
      return { cursor: 'next', data: [row(MARKET, BORROWER)] }
    }
    await discoverBorrowers(fetchPage, { logger, maxPages: 3 })
    expect(calls).toBe(3)
    expect(events.some(e => e.level === 'warn' && e.event === 'discover.max_pages')).toBe(true)
  })
})

describe('createApiCandidateSource', () => {
  const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers })

  it('requests the built URL and returns {cursor, data} from the envelope', async () => {
    let requestedUrl = ''
    const fetchImpl = async (url: string) => {
      requestedUrl = url
      return jsonResponse({ cursor: 'next', data: [row(MARKET, BORROWER)] })
    }
    const source = createApiCandidateSource({
      url: BASE_URL,
      chainId: 8453,
      healthFactorLte: 1.02,
      fetchImpl
    })
    const page: CandidatePage = await source(null)
    expect(new URL(requestedUrl).searchParams.get('health_factor_lte')).toBe('1.02')
    expect(page.cursor).toBe('next')
    expect(page.data).toHaveLength(1)
  })

  it('passes the cursor through on subsequent pages', async () => {
    let requestedUrl = ''
    const fetchImpl = async (url: string) => {
      requestedUrl = url
      return jsonResponse({ cursor: null, data: [] })
    }
    const source = createApiCandidateSource({
      url: BASE_URL,
      chainId: 8453,
      healthFactorLte: 1.02,
      fetchImpl
    })
    await source('page-2-cursor')
    expect(new URL(requestedUrl).searchParams.get('cursor')).toBe('page-2-cursor')
  })

  it('retries on 429 (honoring Retry-After) and then succeeds', async () => {
    let attempts = 0
    let slept = 0
    const fetchImpl = async () => {
      attempts += 1
      if (attempts === 1) return jsonResponse({}, 429, { 'retry-after': '0' })
      return jsonResponse({ cursor: null, data: [row(MARKET, BORROWER)] })
    }
    const source = createApiCandidateSource({
      url: BASE_URL,
      chainId: 8453,
      healthFactorLte: 1.02,
      fetchImpl,
      sleep: async () => {
        slept += 1
      }
    })
    const page = await source(null)
    expect(attempts).toBe(2)
    expect(slept).toBe(1)
    expect(page.data).toHaveLength(1)
  })

  it('coerces a null cursor and non-array data to a safe empty page', async () => {
    const fetchImpl = async () => jsonResponse({ cursor: null, data: undefined })
    const source = createApiCandidateSource({
      url: BASE_URL,
      chainId: 8453,
      healthFactorLte: 1.02,
      fetchImpl
    })
    expect(await source(null)).toEqual({ cursor: null, data: [] })
  })

  it('throws on a non-retryable 4xx so the tick can log and move on', async () => {
    const fetchImpl = async () => jsonResponse({ error: { code: 'INVALID_CURSOR' } }, 400)
    const source = createApiCandidateSource({
      url: BASE_URL,
      chainId: 8453,
      healthFactorLte: 1.02,
      fetchImpl
    })
    expect(source('bad-cursor')).rejects.toThrow('HTTP 400')
  })
})
