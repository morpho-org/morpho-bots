import { describe, expect, it, vi } from 'vitest'

import { TokenMetadataLoader } from '../../src/tokens/metadata'
import { TokenRegistry } from '../../src/tokens/registry'
import { fakeLogger } from '../helpers'
import { MARKET_A, MARKET_B } from '../midnight/fixtures'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WETH = '0x4200000000000000000000000000000000000006'

/** The documented `GET /v0/tokens/{chain_id}:{address}` payload. */
function tokenBody(over: Record<string, unknown> = {}) {
  return {
    data: {
      chain_id: 8453,
      address: USDC,
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 6,
      logo_uri: null,
      tags: null,
      ...over
    }
  }
}

function market(id: string, loan: string, collaterals: string[] = []) {
  return {
    market_id: id,
    chain_id: 8453,
    loan_token: loan,
    collaterals: collaterals.map(token => ({ token }))
  }
}

type GetInit = { params: { path: { 'token-selector': string } } }

/**
 * Mocks the typed core client at the openapi-fetch boundary, the same way the other poller tests
 * mock the Midnight client — `respond` receives the selector the loader asked for.
 */
function makeLoader(respond: (selector: string) => unknown, ok = true) {
  const tokens = new TokenRegistry()
  const logger = fakeLogger()
  const GET = vi.fn((_path: string, init: GetInit) => {
    const selector = init.params.path['token-selector']
    if (!ok) return Promise.reject(new Error('token lookup failed: HTTP 404'))
    return Promise.resolve({ data: respond(selector), response: new Response('{}') })
  })
  const loader = new TokenMetadataLoader({
    client: { GET } as never,
    logger,
    tokens,
    sleep: () => Promise.resolve()
  })
  return { loader, tokens, logger, fetchImpl: GET }
}

describe('TokenMetadataLoader', () => {
  it('resolves metadata for every token a market references', async () => {
    const { loader, tokens, fetchImpl } = makeLoader(selector =>
      selector.toLowerCase().includes(WETH.toLowerCase())
        ? tokenBody({ address: WETH, name: 'Wrapped Ether', symbol: 'WETH', decimals: 18 })
        : tokenBody()
    )
    tokens.record(market(MARKET_A, USDC, [WETH]))

    expect(await loader.ensure()).toBe(2)
    expect(tokens.token(8453, USDC)).toEqual({
      chainId: 8453,
      address: USDC,
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 6
    })
    expect(tokens.token(8453, WETH)?.decimals).toBe(18)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('asks for the documented <chain_id>:<address> selector', async () => {
    const { loader, tokens, fetchImpl } = makeLoader(() => tokenBody())
    tokens.record(market(MARKET_A, USDC))
    await loader.ensure()
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/v0/tokens/{token-selector}')
    expect(fetchImpl.mock.calls[0]?.[1]?.params.path['token-selector']).toBe(`8453:${USDC}`)
  })

  it('resolves each token once even when several markets share it', async () => {
    const { loader, tokens, fetchImpl } = makeLoader(() => tokenBody())
    tokens.record(market(MARKET_A, USDC))
    tokens.record(market(MARKET_B, USDC))
    await loader.ensure()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never refetches a token it already resolved', async () => {
    const { loader, tokens, fetchImpl } = makeLoader(() => tokenBody())
    tokens.record(market(MARKET_A, USDC))
    await loader.ensure()
    // Token identity is immutable, so a second sweep must make no requests at all.
    expect(await loader.ensure()).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('leaves a token unresolved on a failed lookup rather than throwing', async () => {
    // Metadata is a presentation nicety — losing it degrades alerts to raw units, which must never
    // escalate into a failed market sweep.
    const { loader, tokens, logger } = makeLoader(() => ({ message: 'Not Found' }), false)
    tokens.record(market(MARKET_A, USDC))

    await expect(loader.ensure()).resolves.toBe(0)
    expect(tokens.token(8453, USDC)).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      'tokens.lookup_failed',
      expect.objectContaining({ chainId: 8453, address: USDC })
    )
  })

  it('retries an unresolved token on the next sweep', async () => {
    let fail = true
    const { loader, tokens, fetchImpl } = makeLoader(() => {
      if (fail) throw new Error('down')
      return tokenBody()
    })
    tokens.record(market(MARKET_A, USDC))
    await loader.ensure()
    expect(tokens.token(8453, USDC)).toBeNull()

    fail = false
    expect(await loader.ensure()).toBe(1)
    expect(tokens.token(8453, USDC)?.decimals).toBe(6)
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)
  })

  it.each([
    ['missing decimals', { decimals: undefined }],
    ['non-integer decimals', { decimals: 6.5 }],
    ['out-of-range decimals', { decimals: 300 }],
    ['malformed address', { address: 'not-an-address' }],
    ['missing chain_id', { chain_id: undefined }]
  ])('rejects a response with %s instead of storing it', async (_label, over) => {
    // Generated types are compile-time only, and this is a separate service on its own deploy
    // cycle — drift must surface as a warn and a fallback to raw units, never as NaN decimals
    // silently corrupting every formatted amount.
    const { loader, tokens, logger } = makeLoader(() => tokenBody(over))
    tokens.record(market(MARKET_A, USDC))

    expect(await loader.ensure()).toBe(0)
    expect(tokens.token(8453, USDC)).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith('tokens.unparsable', expect.anything())
  })

  it('accepts the nullable name and symbol the schema permits', async () => {
    const { loader, tokens } = makeLoader(() => tokenBody({ name: null, symbol: null }))
    tokens.record(market(MARKET_A, USDC))
    await loader.ensure()
    // decimals is the field that matters; name/symbol are explicitly nullable upstream.
    expect(tokens.token(8453, USDC)).toEqual({
      chainId: 8453,
      address: USDC,
      name: null,
      symbol: null,
      decimals: 6
    })
  })

  it('makes no requests when nothing is missing', async () => {
    const { loader, fetchImpl } = makeLoader(() => tokenBody())
    expect(await loader.ensure()).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('warns once per token then drops repeats to debug', async () => {
    // A token that never resolves is retried every sweep by design. Without de-escalation an
    // unreachable endpoint emits one warn per token per refresh — ~2,300/day for 16 tokens —
    // which trains operators to ignore warns entirely.
    const { loader, tokens, logger } = makeLoader(() => ({}), false)
    tokens.record(market(MARKET_A, USDC))

    await loader.ensure()
    await loader.ensure()
    await loader.ensure()

    const warns = logger.warn as unknown as { mock: { calls: unknown[][] } }
    const failWarns = warns.mock.calls.filter(call => call[0] === 'tokens.lookup_failed')
    expect(failWarns).toHaveLength(1)
    const debugs = logger.debug as unknown as { mock: { calls: unknown[][] } }
    expect(debugs.mock.calls.filter(call => call[0] === 'tokens.lookup_failed')).toHaveLength(2)
  })

  it('warns again if a token regresses after resolving', async () => {
    let ok = true
    const { loader, tokens, logger } = makeLoader(() => {
      if (!ok) throw new Error('down')
      return tokenBody()
    })
    tokens.record(market(MARKET_A, USDC))
    await loader.ensure()

    // Force a re-fetch of the now-resolved token by introducing a second market with a new token,
    // then breaking the endpoint — the previously-successful token must be eligible to warn again.
    ok = false
    tokens.record(market(MARKET_B, WETH))
    await loader.ensure()
    const warns = logger.warn as unknown as { mock: { calls: unknown[][] } }
    expect(warns.mock.calls.some(call => call[0] === 'tokens.lookup_failed')).toBe(true)
  })

  it('warns instead of reporting success when nothing resolves at all', async () => {
    const { loader, tokens, logger } = makeLoader(() => ({}), false)
    tokens.record(market(MARKET_A, USDC))
    await loader.ensure()
    // An info line named "resolved" that permanently reports zero reads as success when skimmed.
    expect(logger.warn).toHaveBeenCalledWith(
      'tokens.unresolved',
      expect.objectContaining({ requested: 1, resolved: 0, unresolved: 1 })
    )
    expect(logger.info).not.toHaveBeenCalledWith('tokens.resolved', expect.anything())
  })
})
