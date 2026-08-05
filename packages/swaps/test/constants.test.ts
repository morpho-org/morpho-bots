import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { ONEINCH_ROUTER, PENDLE_CHAIN_IDS } from '../src/constants'

// Literal chainId → address pairs (independent of the source's viem/chains imports) so a wrong id or
// address in ONEINCH_ROUTER is caught. AggregationRouterV6 is canonical everywhere except zkSync Era.
const CANONICAL = getAddress('0x111111125421cA6dc452d289314280a0f8842A65')
const EXPECTED: Record<number, string> = {
  1: CANONICAL, // Ethereum
  10: CANONICAL, // Optimism
  56: CANONICAL, // BNB Chain
  100: CANONICAL, // Gnosis
  137: CANONICAL, // Polygon
  8453: CANONICAL, // Base
  42161: CANONICAL, // Arbitrum One
  43114: CANONICAL, // Avalanche
  59144: CANONICAL, // Linea
  324: getAddress('0x6fd4383cB451173D5f9304F041C7BCBf27d561fF'), // zkSync Era (divergent)
  4663: getAddress('0x5A705DE8982235a7fa45bB83dCaCf03a211389C7') // Robinhood (divergent, blue chain)
}

describe('ONEINCH_ROUTER', () => {
  it('maps every supported chain to its checksummed AggregationRouterV6 address', () => {
    for (const [chainId, address] of Object.entries(EXPECTED)) {
      expect(ONEINCH_ROUTER[Number(chainId)]).toBe(getAddress(address))
    }
  })

  it('contains exactly the supported chains and nothing else', () => {
    expect(
      Object.keys(ONEINCH_ROUTER)
        .map(Number)
        .toSorted((a, b) => a - b)
    ).toEqual(
      Object.keys(EXPECTED)
        .map(Number)
        .toSorted((a, b) => a - b)
    )
  })

  it('has no entry for an unsupported chain (fails closed in quoteOneInch)', () => {
    expect(ONEINCH_ROUTER[31337]).toBeUndefined() // anvil/local — no 1inch deployment
  })
})

describe('PENDLE_CHAIN_IDS', () => {
  it('includes Base (the deployed bot chain Pendle serves) and excludes Robinhood', () => {
    expect(PENDLE_CHAIN_IDS.has(8453)).toBe(true) // Base — PT collateral markets live here
    expect(PENDLE_CHAIN_IDS.has(4663)).toBe(false) // Robinhood — no Pendle deployment
    expect(PENDLE_CHAIN_IDS.has(31337)).toBe(false) // anvil/local
  })
})
