import type { Logger } from '@repo/bot-kit'
import type { Address } from 'viem'

import { USD_LADDER_PRICE_DECIMALS } from '@repo/swaps'
import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { createTokenPriceSource, USD_PRICE_SCALE_DECIMALS } from '../../src/discovery/token-prices'

const BASE_URL = 'https://api.example.test/markets/midnight/liquidation-candidates'
const USDC: Address = getAddress('0x1111111111111111111111111111111111111111')
const WETH: Address = getAddress('0x2222222222222222222222222222222222222222')
const UNLISTED: Address = getAddress('0x3333333333333333333333333333333333333333')

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}

function capturingLogger() {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = []
  const make = (level: string) => (event: string, fields?: Record<string, unknown>) =>
    events.push({ level, event, fields })
  return {
    logger: { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') },
    find: (event: string) => events.find(e => e.event === event)
  }
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })

// `address`/`decimals`/`price` are `unknown` so malformed rows type-check in the bad-input cases.
const row = (address: unknown, decimals: unknown, usd: unknown, chainId = 8453) => ({
  chain_id: chainId,
  address,
  name: 'Token',
  symbol: 'TKN',
  decimals,
  logo_uri: null,
  tags: null,
  is_listed: true,
  price: usd === null ? null : { usd, timestamp: 1_700_000_000 }
})

const sourceWith = (body: unknown, status = 200, logger: Logger = NOOP_LOGGER) =>
  createTokenPriceSource({
    apiUrl: BASE_URL,
    chainId: 8453,
    logger,
    fetchImpl: async () => jsonResponse(body, status)
  })

describe('createTokenPriceSource', () => {
  it('requests the tokens path for the configured chain', async () => {
    let requestedUrl = ''
    const source = createTokenPriceSource({
      apiUrl: BASE_URL,
      chainId: 8453,
      logger: NOOP_LOGGER,
      fetchImpl: async request => {
        requestedUrl = request.url
        return jsonResponse({ data: [] })
      }
    })
    await source.refresh()
    const url = new URL(requestedUrl)
    expect(url.pathname).toBe('/markets/midnight/tokens')
    expect(url.searchParams.get('chain_ids')).toBe('8453')
    // Not narrowed by market or listing status — the whitelist already gates what we act on.
    expect(url.searchParams.has('markets')).toBe(false)
    expect(url.searchParams.has('listed')).toBe(false)
  })

  it('values loan amounts at the 1e8 USD scale across differing decimals', async () => {
    const source = sourceWith({
      data: [row(USDC, 6, 1), row(WETH, 18, 2500)]
    })
    await source.refresh()
    // 1 USDC at $1.00 → 1.00000000 at 1e8
    expect(source.usdValueOf(USDC, 1_000_000n)).toBe(100_000_000n)
    // 1 WETH at $2500 → 2500.00000000 at 1e8
    expect(source.usdValueOf(WETH, 10n ** 18n)).toBe(250_000_000_000n)
    // Scales linearly, and floors rather than rounding up.
    expect(source.usdValueOf(USDC, 1n)).toBe(100n)
    expect(source.snapshot()).toMatchObject({ tokens: 2 })
  })

  it('prices one whole token without a chain read, at the ladder scale the selector expects', async () => {
    // The probe ladder's denomination hangs off this, and `@repo/swaps` fixes its own scale
    // independently — nothing but this assertion couples the two, and a divergence would silently
    // mis-size every rung by orders of magnitude.
    expect(USD_LADDER_PRICE_DECIMALS).toBe(USD_PRICE_SCALE_DECIMALS)

    const source = sourceWith({ data: [row(USDC, 6, 1), row(WETH, 18, 2500)] })
    await source.refresh()
    expect(source.usdPriceOf(USDC)).toBe(100_000_000n)
    expect(source.usdPriceOf(WETH)).toBe(250_000_000_000n)
    // The per-unit form of the same figure, so the two cannot disagree about one whole token.
    expect(source.usdPriceOf(WETH)).toBe(source.usdValueOf(WETH, 10n ** 18n))
    expect(source.usdPriceOf(UNLISTED)).toBeNull()
  })

  it('is case-insensitive on the token address', async () => {
    const source = sourceWith({ data: [row(USDC.toLowerCase(), 6, 1)] })
    await source.refresh()
    expect(source.usdValueOf(USDC, 1_000_000n)).toBe(100_000_000n)
  })

  it('returns null for a token absent from the snapshot', async () => {
    const source = sourceWith({ data: [row(USDC, 6, 1)] })
    await source.refresh()
    expect(source.usdValueOf(UNLISTED, 1n)).toBeNull()
  })

  it('drops rows with no price, no decimals, a non-positive price, or a bad address', async () => {
    const source = sourceWith({
      data: [
        row(USDC, 6, 1), // ok
        row(WETH, 18, null), // price: null — the collateral wrappers really do come back this way
        row(UNLISTED, null, 1), // decimals: null
        row(getAddress('0x4444444444444444444444444444444444444444'), 18, 0), // usd: 0
        row(getAddress('0x5555555555555555555555555555555555555555'), 18, -1), // usd: negative
        row('not-an-address', 18, 1),
        row(getAddress('0x6666666666666666666666666666666666666666'), 18, 1, 1) // wrong chain
      ]
    })
    await source.refresh()
    expect(source.snapshot()).toMatchObject({ tokens: 1 })
    expect(source.usdValueOf(USDC, 1_000_000n)).toBe(100_000_000n)
    expect(source.usdValueOf(WETH, 1n)).toBeNull()
    expect(source.usdValueOf(UNLISTED, 1n)).toBeNull()
  })

  it('treats a price with no usable 1e8 precision as unpriced rather than as zero', async () => {
    const source = sourceWith({ data: [row(USDC, 6, 1e-12)] })
    await source.refresh()
    expect(source.usdValueOf(USDC, 1_000_000n)).toBeNull()
  })

  it('keeps last-known-good and does not reject when the API fails', async () => {
    let status = 200
    const logs = capturingLogger()
    const source = createTokenPriceSource({
      apiUrl: BASE_URL,
      chainId: 8453,
      logger: logs.logger,
      sleep: async () => {},
      fetchImpl: async () => jsonResponse({ data: [row(USDC, 6, 1)] }, status)
    })
    await source.refresh()
    expect(source.usdValueOf(USDC, 1_000_000n)).toBe(100_000_000n)

    status = 500
    // Contractually non-throwing: ranking degrades, it never fails closed.
    await expect(source.refresh()).resolves.toBeUndefined()
    expect(source.usdValueOf(USDC, 1_000_000n)).toBe(100_000_000n)
    expect(logs.find('prices.refresh_failed')?.level).toBe('warn')
  })

  it('retries a 429 honoring retry-after', async () => {
    let attempts = 0
    let slept = 0
    const source = createTokenPriceSource({
      apiUrl: BASE_URL,
      chainId: 8453,
      logger: NOOP_LOGGER,
      sleep: async () => {
        slept += 1
      },
      fetchImpl: async () => {
        attempts += 1
        if (attempts === 1) {
          return jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '0' })
        }
        return jsonResponse({ data: [row(USDC, 6, 1)] })
      }
    })
    await source.refresh()
    expect(attempts).toBe(2)
    expect(slept).toBe(1)
    expect(source.usdValueOf(USDC, 1_000_000n)).toBe(100_000_000n)
  })

  it('warns when a previously-populated snapshot comes back empty', async () => {
    let body: unknown = { data: [row(USDC, 6, 1)] }
    const logs = capturingLogger()
    const source = createTokenPriceSource({
      apiUrl: BASE_URL,
      chainId: 8453,
      logger: logs.logger,
      fetchImpl: async () => jsonResponse(body)
    })
    await source.refresh()
    body = { data: [] }
    await source.refresh()
    expect(logs.find('prices.tokens_empty')?.fields).toMatchObject({ previous: 1 })
    expect(source.usdValueOf(USDC, 1n)).toBeNull()
  })

  it('reports an unfetched snapshot as empty with no timestamp', () => {
    const source = sourceWith({ data: [] })
    expect(source.snapshot()).toMatchObject({ tokens: 0, updatedAt: null })
    expect(source.usdValueOf(USDC, 1n)).toBeNull()
  })

  it('stamps updatedAt from the injected clock on a successful refresh', async () => {
    const source = createTokenPriceSource({
      apiUrl: BASE_URL,
      chainId: 8453,
      logger: NOOP_LOGGER,
      now: () => 1_234,
      fetchImpl: async () => jsonResponse({ data: [row(USDC, 6, 1)] })
    })
    await source.refresh()
    expect(source.snapshot().updatedAt).toBe(1_234)
  })
})
