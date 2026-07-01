import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'
import { base } from 'viem/chains'

import type { ChainConfig } from '../src/config'

import { loadConfig, parseSwapConfig } from '../src/config'

const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
const KEY = `0x${'1'.repeat(64)}`

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    CHAIN_ID: String(base.id),
    RPC_URL: 'https://base.example',
    LIQUIDATOR_PRIVATE_KEY: KEY,
    DATABASE_URL: 'postgres://localhost/blue',
    ...overrides
  }
  for (const k of Object.keys(overrides)) if (overrides[k] === undefined) delete env[k]
  return env
}

// ENOENT-style readFile: a swap config path set but the file not present yet (non-fatal).
const missingFileRead = (): string => {
  const err = new Error('no such file') as Error & { code: string }
  err.code = 'ENOENT'
  throw err
}

describe('loadConfig', () => {
  it('loads a valid Base config with the canonical Morpho singleton', () => {
    const config = loadConfig(baseEnv())
    expect(config.chainId).toBe(base.id)
    expect(config.morpho).toBe(MORPHO)
    expect(config.chain.id).toBe(base.id)
    expect(config.rpcUrl).toBe('https://base.example')
    // Executor address is derived from the deterministic CREATE2 factory when not overridden.
    expect(config.executooorAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(config.swapConfig).toEqual({})
  })

  it('fails loud on each missing required var', () => {
    expect(() => loadConfig(baseEnv({ CHAIN_ID: undefined }))).toThrow(/CHAIN_ID/)
    expect(() => loadConfig(baseEnv({ RPC_URL: undefined }))).toThrow(/RPC_URL/)
    expect(() => loadConfig(baseEnv({ LIQUIDATOR_PRIVATE_KEY: undefined }))).toThrow(
      /LIQUIDATOR_PRIVATE_KEY/
    )
    expect(() => loadConfig(baseEnv({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL/)
  })

  it('rejects an unsupported chain id', () => {
    expect(() => loadConfig(baseEnv({ CHAIN_ID: '1' }))).toThrow(/Unsupported CHAIN_ID/)
  })

  it('honors an injected chain map (so a new chain is wired in one place)', () => {
    const chainMap: Record<number, ChainConfig> = {
      [base.id]: { chain: base, morpho: MORPHO }
    }
    expect(loadConfig(baseEnv(), { chainMap }).morpho).toBe(MORPHO)
    // A chain absent from the injected map is rejected even if it is a real chain id.
    expect(() => loadConfig(baseEnv({ CHAIN_ID: '10' }), { chainMap })).toThrow(/Unsupported/)
  })

  it('rejects a malformed private key', () => {
    expect(() => loadConfig(baseEnv({ LIQUIDATOR_PRIVATE_KEY: '0xdeadbeef' }))).toThrow(
      /LIQUIDATOR_PRIVATE_KEY/
    )
  })

  it('treats an absent swap-config file as no routes (non-fatal first-deploy bootstrap)', () => {
    const config = loadConfig(baseEnv({ SWAP_CONFIG_PATH: '/config/swap.json' }), {
      readFile: missingFileRead
    })
    expect(config.swapConfig).toEqual({})
  })

  it('parses a valid swap config and derives no key requirement for uniswap-v3', () => {
    const swap = {
      [String(base.id)]: {
        '0x4200000000000000000000000000000000000006': {
          venue: 'uniswap-v3',
          router: '0x2626664c2603336E57B271c5C0b26F421741e481',
          fee: 500,
          slippageBps: 100
        }
      }
    }
    const config = loadConfig(baseEnv({ SWAP_CONFIG_PATH: '/config/swap.json' }), {
      readFile: () => JSON.stringify(swap)
    })
    expect(config.swapConfig[String(base.id)]).toBeDefined()
  })

  it('fails loud when a configured venue needs an API key that is not set', () => {
    const swap = {
      [String(base.id)]: {
        '0x4200000000000000000000000000000000000006': { venue: '1inch', slippageBps: 100 }
      }
    }
    expect(() =>
      loadConfig(baseEnv({ SWAP_CONFIG_PATH: '/config/swap.json' }), {
        readFile: () => JSON.stringify(swap)
      })
    ).toThrow(/ONEINCH_API_KEY/)
  })
})

describe('parseSwapConfig', () => {
  const COLL = '0x4200000000000000000000000000000000000006'

  it('defaults a venue-less entry to uniswap-v3 (back-compat)', () => {
    const parsed = parseSwapConfig({
      '8453': {
        [COLL]: { router: '0x2626664c2603336E57B271c5C0b26F421741e481', fee: 500, slippageBps: 100 }
      }
    })
    expect(parsed['8453']?.[COLL]).toMatchObject({ venue: 'uniswap-v3', fee: 500 })
  })

  it('rejects a non-numeric chain-id key and an out-of-range slippage', () => {
    expect(() => parseSwapConfig({ base: {} })).toThrow()
    expect(() =>
      parseSwapConfig({ '8453': { [COLL]: { venue: '0x', slippageBps: 20_000 } } })
    ).toThrow()
  })
})
