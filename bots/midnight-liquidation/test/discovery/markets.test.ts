import type { LogLevel, Logger } from '@repo/bot-kit'
import type { Hex } from 'viem'

import { describe, expect, it } from 'vitest'

import {
  createListedMarketFilter,
  createUnionListedMarketFilter
} from '../../src/discovery/markets'

const API_URL = 'https://api.example/v0/midnight/markets'
const LISTED: Hex = `0x${'a'.repeat(64)}`
const UNLISTED: Hex = `0x${'b'.repeat(64)}`
const OTHER_CHAIN: Hex = `0x${'c'.repeat(64)}`
const SHARED: Hex = `0x${'d'.repeat(64)}`
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

// A capturing logger so operator-visible events are assertable by name, level, and fields.
const capturingLogger = () => {
  const events: { level: LogLevel; event: string; fields: Record<string, unknown> }[] = []
  const record = (level: LogLevel) => (event: string, fields?: Record<string, unknown>) => {
    events.push({ level, event, fields: fields ?? {} })
  }
  return {
    names: () => events.map(entry => entry.event),
    find: (event: string) => events.find(entry => entry.event === event),
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error')
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

// Source labels carry the path, so `https://<host>/v0/midnight/markets` labels as `<host>/v0/...`.
const label = (host: string) => `${host}/v0/midnight/markets`

describe('createListedMarketFilter pagination', () => {
  // A truncated whitelist is fail-closed under-inclusion: the dropped markets stop being liquidated
  // with no error anywhere. The server's page size is not ours to control, so the walk must follow
  // the cursor rather than trusting one response to be complete.
  it('follows the cursor across pages and whitelists markets from every page', async () => {
    const cursors: (string | null)[] = []
    const fetchImpl = async (request: Request) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      cursors.push(cursor)
      if (cursor === null) return jsonResponse({ cursor: 'page-2', data: [market(LISTED)] })
      return jsonResponse({ cursor: null, data: [market(SHARED)] })
    }
    const filter = createListedMarketFilter({
      apiUrl: API_URL,
      chainId: 8453,
      logger: NOOP_LOGGER,
      fetchImpl,
      sleep: async () => {}
    })
    await filter.refresh()

    expect(cursors).toEqual([null, 'page-2'])
    expect(filter.isListed(LISTED)).toBe(true)
    // Would be missing if the walk stopped at page one — the bug this guards.
    expect(filter.isListed(SHARED)).toBe(true)
    expect(filter.snapshot().markets).toBe(2)
  })

  it('sends an explicit page limit rather than relying on the server default', async () => {
    let requested = ''
    const filter = createListedMarketFilter({
      apiUrl: API_URL,
      chainId: 8453,
      logger: NOOP_LOGGER,
      fetchImpl: async request => {
        requested = request.url
        return jsonResponse({ cursor: null, data: [] })
      },
      sleep: async () => {}
    })
    await filter.refresh()

    expect(new URL(requested).searchParams.get('limit')).toBe('100')
  })

  it('stops at the page cap and logs it loud rather than walking a runaway cursor', async () => {
    const logger = capturingLogger()
    const filter = createListedMarketFilter({
      apiUrl: API_URL,
      chainId: 8453,
      logger: logger.logger,
      // Never returns a null cursor — the runaway case the backstop exists for.
      fetchImpl: async () => jsonResponse({ cursor: 'next', data: [market(LISTED)] }),
      sleep: async () => {}
    })
    await filter.refresh()

    const capped = logger.find('markets.max_pages')
    expect(capped?.level).toBe('warn')
    expect(capped?.fields.cap).toBe(50)
    expect(capped?.fields.pages).toBe(50)
  })
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
    expect(filter.snapshot()).toEqual({
      source: 'api.example/v0/midnight/markets',
      markets: 1,
      updatedAt: 111
    })
  })

  // The label carries the path so two sources on one host stay distinguishable in logs.
  it('labels a source by host and path, excluding the query string', () => {
    const filter = createListedMarketFilter({
      apiUrl: 'https://api.example/staging/v0/midnight/markets?token=secret',
      chainId: 8453,
      logger: NOOP_LOGGER,
      fetchImpl: async () => jsonResponse({ data: [] })
    })
    expect(filter.snapshot().source).toBe('api.example/staging/v0/midnight/markets')
  })

  // An empty 200 is not a transient failure, so it replaces last-known-good — but in a union a healthy
  // peer would mask it, so the nonempty→empty transition has to be loud on its own.
  it('warns when a source drops from some listed markets to none', async () => {
    const logs = capturingLogger()
    let call = 0
    const filter = createListedMarketFilter({
      apiUrl: API_URL,
      chainId: 8453,
      logger: logs.logger,
      fetchImpl: async () => {
        call += 1
        return jsonResponse({ data: call === 1 ? [market(LISTED)] : [] })
      }
    })
    await filter.refresh()
    expect(logs.names()).not.toContain('markets.listed_empty')

    await filter.refresh()
    expect(filter.isListed(LISTED)).toBe(false) // the empty response is authoritative
    expect(logs.find('markets.listed_empty')?.fields.previous).toBe(1)
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

describe('createUnionListedMarketFilter', () => {
  it('whitelists the union of every fresh source', async () => {
    const union = createUnionListedMarketFilter({
      chainId: 8453,
      filters: [
        sourceFilter({ host: 'a.example', markets: [LISTED], now: () => 0 }),
        sourceFilter({ host: 'b.example', markets: [OTHER_CHAIN], now: () => 0 })
      ],
      maxAgeMs: 1_000,
      logger: NOOP_LOGGER,
      now: () => 0
    })
    await union.refresh()
    const whitelist = union.current()

    expect(whitelist.isListed(LISTED)).toBe(true) // only in source a
    expect(whitelist.isListed(OTHER_CHAIN)).toBe(true) // only in source b
    expect(whitelist.isListed(UNLISTED)).toBe(false) // in neither
    expect(whitelist.fresh).toBe(2)
    expect(union.snapshot().sources.map(source => source.source)).toEqual([
      label('a.example'),
      label('b.example')
    ])
  })

  // The combined size cannot be recovered from the per-source counts, so it is emitted on its own
  // event: summing would double-count the shared market, and taking the max would report 2, not 3.
  it('reports the deduplicated union size on markets.whitelist', async () => {
    const logs = capturingLogger()
    const union = createUnionListedMarketFilter({
      chainId: 8453,
      filters: [
        sourceFilter({ host: 'a.example', markets: [LISTED, SHARED], now: () => 0 }),
        sourceFilter({ host: 'b.example', markets: [OTHER_CHAIN, SHARED], now: () => 0 })
      ],
      maxAgeMs: 1_000,
      logger: logs.logger,
      now: () => 0
    })
    await union.refresh()

    expect(logs.find('markets.whitelist')?.fields).toEqual({
      chainId: 8453,
      markets: 3,
      sources: 2,
      fresh: 2
    })
  })

  it('throws rather than silently listing nothing when no source is configured', () => {
    expect(() =>
      createUnionListedMarketFilter({
        chainId: 8453,
        filters: [],
        maxAgeMs: 1_000,
        logger: NOOP_LOGGER
      })
    ).toThrow(/requires at least one markets source/)
  })

  it('is fail-closed before the first refresh (no source has a set yet)', () => {
    const union = createUnionListedMarketFilter({
      chainId: 8453,
      filters: [sourceFilter({ host: 'a.example', markets: [LISTED] })],
      maxAgeMs: 1_000,
      logger: NOOP_LOGGER,
      now: () => 0
    })
    expect(union.current().isListed(LISTED)).toBe(false)
    expect(union.current().fresh).toBe(0)
    expect(union.snapshot().sources[0]?.expired).toBe(true)
  })

  // The core safety property of reading more than one source: staleness is judged PER SOURCE, so one
  // endpoint going stale narrows the whitelist instead of emptying it.
  it('drops an expired source from the union while a fresh peer keeps working', async () => {
    const logs = capturingLogger()
    const union = createUnionListedMarketFilter({
      chainId: 8453,
      filters: [
        sourceFilter({ host: 'stale.example', markets: [LISTED], now: () => 0 }),
        sourceFilter({ host: 'fresh.example', markets: [OTHER_CHAIN], now: () => 1_000 })
      ],
      maxAgeMs: 100,
      logger: logs.logger,
      now: () => 1_000
    })
    await union.refresh()
    const whitelist = union.current()

    expect(whitelist.isListed(LISTED)).toBe(false) // stale source contributes nothing
    expect(whitelist.isListed(OTHER_CHAIN)).toBe(true) // fresh peer still whitelists
    expect(whitelist.fresh).toBe(1)
    expect(logs.find('markets.source_expired')?.fields).toEqual({
      chainId: 8453,
      expired: [label('stale.example')],
      maxAgeMs: 100,
      detail:
        'markets source older than max age — excluded from the whitelist until a refresh lands'
    })
    // Only the fresh peer's markets count toward the combined size.
    expect(logs.find('markets.whitelist')?.fields).toEqual({
      chainId: 8453,
      markets: 1,
      sources: 2,
      fresh: 1
    })
  })

  // When EVERY source is stale the union stays silent by design: the caller reports that per tick, so
  // a refresh interval longer than maxAgeMs cannot leave the halt unreported between refreshes.
  it('leaves the all-expired case to the caller rather than warning per refresh', async () => {
    const logs = capturingLogger()
    const union = createUnionListedMarketFilter({
      chainId: 8453,
      filters: [sourceFilter({ host: 'stale.example', markets: [LISTED], now: () => 0 })],
      maxAgeMs: 100,
      logger: logs.logger,
      now: () => 1_000
    })
    await union.refresh()

    expect(union.current().isListed(LISTED)).toBe(false)
    expect(union.current().fresh).toBe(0)
    expect(logs.names()).not.toContain('markets.source_expired')
    expect(logs.names()).not.toContain('markets.whitelist_expired')
  })

  // A partial refresh must not read as a total one: the failing source is reported and skipped, and the
  // healthy source's set still lands.
  it('never throws when a source fails, and still lands the healthy sources', async () => {
    const logs = capturingLogger()
    const union = createUnionListedMarketFilter({
      chainId: 8453,
      filters: [
        sourceFilter({ host: 'down.example', fail: true, now: () => 0 }),
        sourceFilter({ host: 'up.example', markets: [LISTED], now: () => 0 })
      ],
      maxAgeMs: 1_000,
      logger: logs.logger,
      now: () => 0
    })

    expect(await union.refresh()).toBeUndefined()
    expect(union.current().isListed(LISTED)).toBe(true)
    expect(logs.find('markets.refresh_failed')?.fields.source).toBe(label('down.example'))
    expect(union.current().fresh).toBe(1)
  })

  // A source that never succeeds is excluded forever; the union must keep serving its fresh peer and
  // must not let the dead source's absence widen or empty the whitelist.
  it('keeps serving a fresh peer across repeated failures of another source', async () => {
    const logs = capturingLogger()
    const union = createUnionListedMarketFilter({
      chainId: 8453,
      filters: [
        sourceFilter({ host: 'down.example', fail: true, now: () => 0 }),
        sourceFilter({ host: 'up.example', markets: [LISTED], now: () => 0 })
      ],
      maxAgeMs: 1_000,
      logger: logs.logger,
      now: () => 0
    })
    await union.refresh()
    await union.refresh()

    expect(union.current().isListed(LISTED)).toBe(true)
    expect(union.current().fresh).toBe(1)
    expect(logs.find('markets.source_expired')?.fields.expired).toEqual([label('down.example')])
  })
})
