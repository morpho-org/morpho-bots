import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import type { LiquidateConfig, ChainConfig, QuotingConfig } from '../src/config'

import { loadLiquidateConfig, loadUnhealthyPositionsConfig } from '../src/config'

const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
const KEY = `0x${'1'.repeat(64)}`
const DERIVED = privateKeyToAccount(KEY as Hex).address

// The per-stage loaders replaced the monolithic `loadConfig`: `sense` reads chain + discovery
// (secret-free), `act` reads Executor + swap routing + the operator EOA, `queue` reads the signer
// key + fee ceiling. One env table feeds all three, so a single baseEnv exercises each loader.
function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    CHAIN_ID: String(base.id),
    RPC_URL: 'https://base.example',
    LIQUIDATOR_PRIVATE_KEY: KEY,
    LIQUIDATOR_ADDRESS: DERIVED,
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

describe('loadUnhealthyPositionsConfig', () => {
  it('loads a valid Base config with the canonical Morpho singleton (secret-free)', () => {
    const config = loadUnhealthyPositionsConfig(baseEnv())
    expect(config.chainId).toBe(base.id)
    expect(config.network).toBe('base')
    expect(config.morpho).toBe(MORPHO)
    expect(config.chain.id).toBe(base.id)
    expect(config.rpcUrl).toBe('https://base.example')
    expect(config.databaseUrl).toBe('postgres://localhost/blue')
  })

  it('resolves the Robinhood chain with its own (non-canonical) Morpho singleton and network', () => {
    const config = loadUnhealthyPositionsConfig(baseEnv({ CHAIN_ID: '4663' }))
    expect(config.chainId).toBe(4663)
    expect(config.network).toBe('robinhood')
    expect(config.morpho).toBe(getAddress('0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010'))
    expect(config.morpho).not.toBe(MORPHO)
  })

  it('fails loud on each missing required var it owns', () => {
    expect(() => loadUnhealthyPositionsConfig(baseEnv({ CHAIN_ID: undefined }))).toThrow(/CHAIN_ID/)
    expect(() => loadUnhealthyPositionsConfig(baseEnv({ RPC_URL: undefined }))).toThrow(/RPC_URL/)
    expect(() => loadUnhealthyPositionsConfig(baseEnv({ DATABASE_URL: undefined }))).toThrow(
      /DATABASE_URL/
    )
  })

  it('rejects an unsupported chain id', () => {
    expect(() => loadUnhealthyPositionsConfig(baseEnv({ CHAIN_ID: '1' }))).toThrow(
      /Unsupported CHAIN_ID/
    )
  })

  it('is loadable WITHOUT the signer private key (sense is secret-free)', () => {
    const config = loadUnhealthyPositionsConfig(baseEnv({ LIQUIDATOR_PRIVATE_KEY: undefined }))
    expect(config.chainId).toBe(base.id)
  })

  it('honors an injected chain map (so a new chain is wired in one place)', () => {
    const chainMap: Record<number, ChainConfig> = {
      [base.id]: { chain: base, morpho: MORPHO, network: 'base' }
    }
    expect(loadUnhealthyPositionsConfig(baseEnv(), { chainMap }).morpho).toBe(MORPHO)
    expect(() => loadUnhealthyPositionsConfig(baseEnv({ CHAIN_ID: '10' }), { chainMap })).toThrow(
      /Unsupported/
    )
  })
})

describe('loadLiquidateConfig', () => {
  it('derives the Executor CREATE2 address and defaults to no swap routes', () => {
    const config: LiquidateConfig = loadLiquidateConfig(baseEnv())
    expect(config.executooorAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(config.swapConfig).toEqual({})
    expect(config.liquidatorAddress).toBe(DERIVED)
  })

  it('parses quoting tunables with safe defaults', () => {
    const quoting: QuotingConfig = loadLiquidateConfig(baseEnv()).quoting
    expect(quoting.maxRouteImpactBps).toBe(500)
    expect(quoting.httpRps).toBe(2)
  })

  it('treats an absent swap-config file as no routes (non-fatal first-deploy bootstrap)', () => {
    const config = loadLiquidateConfig(baseEnv({ SWAP_CONFIG_PATH: '/config/swap.json' }), {
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
    const config = loadLiquidateConfig(baseEnv({ SWAP_CONFIG_PATH: '/config/swap.json' }), {
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
      loadLiquidateConfig(baseEnv({ SWAP_CONFIG_PATH: '/config/swap.json' }), {
        readFile: () => JSON.stringify(swap)
      })
    ).toThrow(/ONEINCH_API_KEY/)
  })

  it('requires LIQUIDATOR_ADDRESS (act has no key to derive it from) and rejects a malformed one', () => {
    expect(() => loadLiquidateConfig(baseEnv({ LIQUIDATOR_ADDRESS: undefined }))).toThrow(
      /LIQUIDATOR_ADDRESS/
    )
    expect(() => loadLiquidateConfig(baseEnv({ LIQUIDATOR_ADDRESS: 'not-an-address' }))).toThrow(
      /LIQUIDATOR_ADDRESS is not a valid address/
    )
  })
})
