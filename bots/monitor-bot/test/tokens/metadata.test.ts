import { describe, expect, it, vi } from 'vitest'

import { TokenMetadataLoader } from '../../src/tokens/metadata'
import { TokenRegistry } from '../../src/tokens/registry'
import { fakeLogger } from '../helpers'
import { MARKET_A, MARKET_B, USDC_TOKEN } from '../midnight/fixtures'

// Deliberately NOT in the registry's KNOWN_TOKENS seeds — the loader only fetches missing tokens,
// so seeded addresses would make every test below a no-op. All-digit hex keeps checksums inert.
const TOKEN_A = '0x1111111111111111111111111111111111111111'
const TOKEN_B = '0x2222222222222222222222222222222222222222'

/** The documented `GET /v0/tokens/{chain_id}:{address}` payload. */
function tokenBody(over: Record<string, unknown> = {}) {
  return {
    data: {
      chain_id: 8453,
      address: TOKEN_A,
      name: 'Token A',
      symbol: 'AAA',
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
      selector.includes(TOKEN_B)
        ? tokenBody({ address: TOKEN_B, name: 'Token B', symbol: 'BBB', decimals: 18 })
        : tokenBody()
    )
    tokens.record(market(MARKET_A, TOKEN_A, [TOKEN_B]))

    expect(await loader.ensure()).toBe(2)
    expect(tokens.token(8453, TOKEN_A)).toEqual({ name: 'Token A', symbol: 'AAA', decimals: 6 })
    expect(tokens.token(8453, TOKEN_B)?.decimals).toBe(18)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('asks for the documented <chain_id>:<address> selector', async () => {
    const { loader, tokens, fetchImpl } = makeLoader(() => tokenBody())
    tokens.record(market(MARKET_A, TOKEN_A))
    await loader.ensure()
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/v0/tokens/{token-selector}')
    expect(fetchImpl.mock.calls[0]?.[1]?.params.path['token-selector']).toBe(`8453:${TOKEN_A}`)
  })

  it('resolves each token once even when several markets share it', async () => {
    const { loader, tokens, fetchImpl } = makeLoader(() => tokenBody())
    tokens.record(market(MARKET_A, TOKEN_A))
    tokens.record(market(MARKET_B, TOKEN_A))
    await loader.ensure()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never refetches a token it already resolved', async () => {
    const { loader, tokens, fetchImpl } = makeLoader(() => tokenBody())
    tokens.record(market(MARKET_A, TOKEN_A))
    await loader.ensure()
    // Token identity is immutable, so a second sweep must make no requests at all.
    expect(await loader.ensure()).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never fetches tokens covered by the KNOWN_TOKENS seeds', async () => {
    const { loader, tokens, fetchImpl } = makeLoader(() => tokenBody())
    tokens.record(market(MARKET_A, USDC_TOKEN))
    expect(await loader.ensure()).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('leaves a token unresolved on a failed lookup rather than throwing', async () => {
    // Metadata is a presentation nicety — losing it degrades alerts to raw units, which must never
    // escalate into a failed market sweep.
    const { loader, tokens, logger } = makeLoader(() => ({ message: 'Not Found' }), false)
    tokens.record(market(MARKET_A, TOKEN_A))

    await expect(loader.ensure()).resolves.toBe(0)
    expect(tokens.token(8453, TOKEN_A)).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      'tokens.lookup_failed',
      expect.objectContaining({ chainId: 8453, address: TOKEN_A })
    )
  })

  it('retries an unresolved token on the next sweep', async () => {
    let fail = true
    const { loader, tokens, fetchImpl } = makeLoader(() => {
      if (fail) throw new Error('down')
      return tokenBody()
    })
    tokens.record(market(MARKET_A, TOKEN_A))
    await loader.ensure()
    expect(tokens.token(8453, TOKEN_A)).toBeNull()

    fail = false
    expect(await loader.ensure()).toBe(1)
    expect(tokens.token(8453, TOKEN_A)?.decimals).toBe(6)
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)
  })

  it.each([
    ['missing decimals', { decimals: undefined }],
    ['non-integer decimals', { decimals: 6.5 }],
    ['out-of-range decimals', { decimals: 300 }],
    ['malformed address', { address: 'not-an-address' }],
    ['missing chain_id', { chain_id: undefined }],
    // Identity mismatches would store the response under the wrong key, leaving the requested
    // token permanently "missing" and refetched every sweep while logging as resolved.
    ['mismatched chain_id', { chain_id: 1 }],
    ['mismatched address', { address: TOKEN_B }],
    // The formatter labels every amount with `symbol`, so a token without one is unusable — it
    // must stay on the raw-units fallback instead of being stored unlabeled.
    ['null symbol', { symbol: null }]
  ])('rejects a response with %s instead of storing it', async (_label, over) => {
    // Generated types are compile-time only, and this is a separate service on its own deploy
    // cycle — drift must surface as a warn and a fallback to raw units, never as NaN decimals
    // silently corrupting every formatted amount.
    const { loader, tokens, logger } = makeLoader(() => tokenBody(over))
    tokens.record(market(MARKET_A, TOKEN_A))

    expect(await loader.ensure()).toBe(0)
    expect(tokens.token(8453, TOKEN_A)).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith('tokens.unparsable', expect.anything())
  })

  it('accepts the nullable name the schema permits', async () => {
    const { loader, tokens } = makeLoader(() => tokenBody({ name: null }))
    tokens.record(market(MARKET_A, TOKEN_A))
    await loader.ensure()
    // decimals and symbol are what formatting needs; name is explicitly nullable upstream.
    expect(tokens.token(8453, TOKEN_A)).toEqual({ name: null, symbol: 'AAA', decimals: 6 })
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
    tokens.record(market(MARKET_A, TOKEN_A))

    await loader.ensure()
    await loader.ensure()
    await loader.ensure()

    const warns = vi.mocked(logger.warn).mock.calls
    expect(warns.filter(call => call[0] === 'tokens.lookup_failed')).toHaveLength(1)
    const debugs = vi.mocked(logger.debug).mock.calls
    expect(debugs.filter(call => call[0] === 'tokens.lookup_failed')).toHaveLength(2)
  })

  it('de-escalates repeated unparsable responses to debug like lookup failures', async () => {
    // A permanently unparsable token (e.g. a null upstream symbol) is refetched every sweep just
    // like a failed lookup, so it must ride the same first-warn-then-debug de-escalation.
    const { loader, tokens, logger } = makeLoader(() => tokenBody({ symbol: null }))
    tokens.record(market(MARKET_A, TOKEN_A))

    await loader.ensure()
    await loader.ensure()

    const warns = vi.mocked(logger.warn).mock.calls
    expect(warns.filter(call => call[0] === 'tokens.unparsable')).toHaveLength(1)
    const debugs = vi.mocked(logger.debug).mock.calls
    expect(debugs.filter(call => call[0] === 'tokens.unparsable')).toHaveLength(1)
  })

  it('warns instead of reporting success when nothing resolves at all', async () => {
    const { loader, tokens, logger } = makeLoader(() => ({}), false)
    tokens.record(market(MARKET_A, TOKEN_A))
    await loader.ensure()
    // An info line named "resolved" that permanently reports zero reads as success when skimmed.
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'tokens.unresolved',
      expect.objectContaining({ requested: 1, resolved: 0, unresolved: 1 })
    )
    expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith('tokens.resolved', expect.anything())
  })
})
