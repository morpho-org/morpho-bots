import type { Logger } from '@repo/bot-kit'
import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'

import {
  createListedMarketFilter,
  createUnionListedMarketFilter
} from '../../src/discovery/markets'

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
    expect(filter.snapshot()).toEqual({ source: 'api.example', markets: 1, updatedAt: 111 })
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

// A capturing logger so the union's operator-visible warnings are assertable.
const capturingLogger = () => {
  const warns: { event: string; fields: Record<string, unknown> }[] = []
  return {
    warns,
    logger: {
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: (event: string, fields?: Record<string, unknown>) => {
        warns.push({ event, fields: fields ?? {} })
      }
    } satisfies Logger
  }
}

// One real single-source filter, so the union is exercised against the actual factory. `now` sets this
// source's `updatedAt`, which is what the union's per-source staleness rule reads.
const sourceFilter = (opts: {
  host: string
  markets?: Hex[]
  now?: () => number
  fail?: boolean
}) =>
  createListedMarketFilter({
    apiUrl: `https://${opts.host}/v0/midnight/markets`,
    chainId: 8453,
    logger: NOOP_LOGGER,
    fetchImpl: async () =>
      opts.fail
        ? jsonResponse({}, 500)
        : jsonResponse({ data: (opts.markets ?? []).map(id => market(id)) }),
    sleep: async () => {},
    now: opts.now
  })

describe('createUnionListedMarketFilter', () => {
  it('whitelists the union of every fresh source', async () => {
    const union = createUnionListedMarketFilter({
      filters: [
        sourceFilter({ host: 'a.example', markets: [LISTED], now: () => 0 }),
        sourceFilter({ host: 'b.example', markets: [OTHER_CHAIN], now: () => 0 })
      ],
      maxAgeMs: 1_000,
      logger: NOOP_LOGGER,
      now: () => 0
    })
    await union.refresh()

    expect(union.isListed(LISTED)).toBe(true) // only in source a
    expect(union.isListed(OTHER_CHAIN)).toBe(true) // only in source b
    expect(union.isListed(UNLISTED)).toBe(false) // in neither
    expect(union.snapshot().fresh).toBe(2)
    expect(union.snapshot().sources.map(s => s.source)).toEqual(['a.example', 'b.example'])
  })

  it('is fail-closed before the first refresh (no source has a set yet)', () => {
    const union = createUnionListedMarketFilter({
      filters: [sourceFilter({ host: 'a.example', markets: [LISTED] })],
      maxAgeMs: 1_000,
      logger: NOOP_LOGGER,
      now: () => 0
    })
    expect(union.isListed(LISTED)).toBe(false)
    expect(union.snapshot().fresh).toBe(0)
    expect(union.snapshot().sources[0]?.expired).toBe(true)
  })

  // The core safety property of reading more than one source: staleness is judged PER SOURCE, so one
  // endpoint going stale narrows the whitelist instead of emptying it.
  it('drops an expired source from the union while a fresh peer keeps working', async () => {
    const { logger, warns } = capturingLogger()
    const union = createUnionListedMarketFilter({
      filters: [
        sourceFilter({ host: 'stale.example', markets: [LISTED], now: () => 0 }),
        sourceFilter({ host: 'fresh.example', markets: [OTHER_CHAIN], now: () => 1_000 })
      ],
      maxAgeMs: 100,
      logger,
      now: () => 1_000
    })
    await union.refresh()

    expect(union.isListed(LISTED)).toBe(false) // stale source contributes nothing
    expect(union.isListed(OTHER_CHAIN)).toBe(true) // fresh peer still whitelists
    expect(union.snapshot().fresh).toBe(1)
    expect(warns.map(w => w.event)).toContain('markets.source_expired')
    expect(warns.find(w => w.event === 'markets.source_expired')?.fields.expired).toEqual([
      'stale.example'
    ])
  })

  it('treats an all-expired whitelist as empty and warns loud', async () => {
    const { logger, warns } = capturingLogger()
    const union = createUnionListedMarketFilter({
      filters: [sourceFilter({ host: 'stale.example', markets: [LISTED], now: () => 0 })],
      maxAgeMs: 100,
      logger,
      now: () => 1_000
    })
    await union.refresh()

    expect(union.isListed(LISTED)).toBe(false)
    expect(union.snapshot().fresh).toBe(0)
    expect(warns.map(w => w.event)).toContain('markets.whitelist_expired')
  })

  // A partial refresh must not read as a total one: the failing source is reported and skipped, and the
  // healthy source's set still lands.
  it('never throws when a source fails, and still lands the healthy sources', async () => {
    const { logger, warns } = capturingLogger()
    const union = createUnionListedMarketFilter({
      filters: [
        sourceFilter({ host: 'down.example', fail: true, now: () => 0 }),
        sourceFilter({ host: 'up.example', markets: [LISTED], now: () => 0 })
      ],
      maxAgeMs: 1_000,
      logger,
      now: () => 0
    })

    expect(await union.refresh()).toBeUndefined()
    expect(union.isListed(LISTED)).toBe(true)
    const failure = warns.find(w => w.event === 'markets.refresh_failed')
    expect(failure?.fields.source).toBe('down.example')
    expect(union.snapshot().fresh).toBe(1)
  })
})
