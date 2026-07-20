import { describe, expect, it } from 'vitest'

import { TokenRegistry } from '../../src/tokens/registry'
import { MARKET_A, MARKET_B } from '../midnight/fixtures'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WETH = '0x4200000000000000000000000000000000000006'
const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'

function market(over: Partial<{ id: string; loan: string; collaterals: string[] }> = {}) {
  return {
    market_id: over.id ?? MARKET_A,
    chain_id: 8453,
    loan_token: over.loan ?? USDC,
    collaterals: (over.collaterals ?? [WETH]).map(token => ({ token }))
  }
}

describe('TokenRegistry', () => {
  it('resolves a market to its loan token and collaterals', () => {
    const registry = new TokenRegistry()
    registry.record(market({ collaterals: [WETH, CBBTC] }))
    expect(registry.get(MARKET_A)).toEqual({
      chainId: 8453,
      loanToken: USDC,
      collaterals: [WETH, CBBTC]
    })
    expect(registry.loanToken(MARKET_A)).toBe(USDC)
  })

  it('returns null for a market it has never seen rather than throwing', () => {
    // The miss path is load-bearing: a transaction poller must fall back to raw units, never fail
    // a tick, when it encounters a market the sweep has not reached yet.
    const registry = new TokenRegistry()
    expect(registry.get(MARKET_B)).toBeNull()
    expect(registry.loanToken(MARKET_B)).toBeNull()
  })

  it('matches market ids case-insensitively in both directions', () => {
    const registry = new TokenRegistry()
    // Written upper, read lower — exercises normalisation on the write side.
    registry.record(market({ id: MARKET_A.toUpperCase() }))
    expect(registry.loanToken(MARKET_A.toLowerCase())).toBe(USDC)

    // Written lower, read upper — exercises the read side, which the above does not: with both
    // ids already lowercase, a read-side bug would pass unnoticed.
    const other = new TokenRegistry()
    other.record(market({ id: MARKET_B.toLowerCase() }))
    expect(other.loanToken(MARKET_B.toUpperCase())).toBe(USDC)
  })

  it('checksums addresses so a lowercase API response still resolves', () => {
    const registry = new TokenRegistry()
    registry.record(market({ loan: USDC.toLowerCase(), collaterals: [WETH.toLowerCase()] }))
    expect(registry.loanToken(MARKET_A)).toBe(USDC)
    expect(registry.get(MARKET_A)?.collaterals).toEqual([WETH])
  })

  it('overwrites on re-record so a changed market self-heals', () => {
    const registry = new TokenRegistry()
    registry.record(market({ loan: USDC }))
    registry.record(market({ loan: WETH, collaterals: [CBBTC] }))
    expect(registry.get(MARKET_A)).toEqual({ chainId: 8453, loanToken: WETH, collaterals: [CBBTC] })
    expect(registry.size).toBe(1)
  })

  it('skips a market with a malformed loan token instead of storing garbage', () => {
    const registry = new TokenRegistry()
    registry.record(market({ loan: 'not-an-address' }))
    expect(registry.get(MARKET_A)).toBeNull()
    expect(registry.size).toBe(0)
  })

  it('drops only the malformed collateral, keeping the rest of the market', () => {
    const registry = new TokenRegistry()
    registry.record(market({ collaterals: [WETH, 'nope', CBBTC] }))
    expect(registry.get(MARKET_A)?.collaterals).toEqual([WETH, CBBTC])
  })

  it('reports how many markets it rejected instead of dropping them silently', () => {
    const registry = new TokenRegistry()
    const dropped = registry.recordAll([
      market({ id: MARKET_A }),
      market({ id: MARKET_B, loan: 'not-an-address' })
    ])
    expect(dropped).toBe(1)
    expect(registry.size).toBe(1)
    expect(registry.loanToken(MARKET_A)).toBe(USDC)
  })

  it('accepts an address whose checksum casing is wrong rather than blanking the market', () => {
    // viem's isAddress defaults to strict checksum validation, which would reject an upstream
    // mixed-case address with a bad checksum — losing an otherwise usable market over casing.
    const registry = new TokenRegistry()
    const badChecksum = '0x833589FCD6eDb6E08f4c7C32d4f71b54bdA02913'
    expect(registry.record(market({ loan: badChecksum }))).toBe(true)
    expect(registry.loanToken(MARKET_A)).toBe(USDC)
  })
})
