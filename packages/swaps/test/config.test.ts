import { describe, expect, it } from 'bun:test'

import { parseSwapConfig } from '../src/config'

describe('parseSwapConfig', () => {
  const COLL = '0x4200000000000000000000000000000000000006'

  it('defaults a venue-less entry to uniswap-v3 (back-compat) and checksums the router', () => {
    const parsed = parseSwapConfig({
      '8453': {
        [COLL]: { router: '0x2626664c2603336e57b271c5c0b26f421741e481', fee: 500, slippageBps: 100 }
      }
    })
    expect(parsed['8453']?.[COLL]).toEqual({
      venue: 'uniswap-v3',
      router: '0x2626664c2603336E57B271c5C0b26F421741e481',
      fee: 500,
      slippageBps: 100
    })
  })

  it('rejects an aggregator entry carrying uniswap-only fields (strict union arm)', () => {
    expect(() =>
      parseSwapConfig({
        '8453': {
          [COLL]: {
            venue: '0x',
            router: '0x2626664c2603336E57B271c5C0b26F421741e481',
            fee: 500,
            slippageBps: 50
          }
        }
      })
    ).toThrow()
  })

  it('parses aggregator entries (0x, 1inch) with optional baseUrl', () => {
    const parsed = parseSwapConfig({
      '8453': {
        [COLL]: { venue: '0x', slippageBps: 100 }
      },
      '4663': {
        [COLL]: { venue: '1inch', baseUrl: 'https://proxy.example', slippageBps: 50 }
      }
    })
    expect(parsed['8453']?.[COLL]).toMatchObject({ venue: '0x' })
    expect(parsed['4663']?.[COLL]).toMatchObject({
      venue: '1inch',
      baseUrl: 'https://proxy.example'
    })
  })

  it('rejects a non-numeric chain-id key and an out-of-range slippage', () => {
    expect(() => parseSwapConfig({ base: {} })).toThrow()
    expect(() =>
      parseSwapConfig({ '8453': { [COLL]: { venue: '0x', slippageBps: 20_000 } } })
    ).toThrow()
  })

  it('rejects an invalid collateral address key and unknown entry fields', () => {
    expect(() =>
      parseSwapConfig({ '8453': { 'not-an-address': { venue: '0x', slippageBps: 1 } } })
    ).toThrow()
    expect(() =>
      parseSwapConfig({ '8453': { [COLL]: { venue: '0x', slippageBps: 1, extra: true } } })
    ).toThrow()
  })
})
