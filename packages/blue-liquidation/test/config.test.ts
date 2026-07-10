import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import type { ActConfig, ChainConfig, QuotingConfig } from '../src/config'
import type { QueueConfig } from '../src/queue-policy'

import { loadActConfig, loadSenseConfig } from '../src/config'
import { loadQueueConfig } from '../src/queue-policy'

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

describe('loadSenseConfig', () => {
  it('loads a valid Base config with the canonical Morpho singleton (secret-free)', () => {
    const config = loadSenseConfig(baseEnv())
    expect(config.chainId).toBe(base.id)
    expect(config.network).toBe('base')
    expect(config.morpho).toBe(MORPHO)
    expect(config.chain.id).toBe(base.id)
    expect(config.rpcUrl).toBe('https://base.example')
    expect(config.databaseUrl).toBe('postgres://localhost/blue')
  })

  it('resolves the Robinhood chain with its own (non-canonical) Morpho singleton and network', () => {
    const config = loadSenseConfig(baseEnv({ CHAIN_ID: '4663' }))
    expect(config.chainId).toBe(4663)
    expect(config.network).toBe('robinhood')
    expect(config.morpho).toBe(getAddress('0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010'))
    expect(config.morpho).not.toBe(MORPHO)
  })

  it('fails loud on each missing required var it owns', () => {
    expect(() => loadSenseConfig(baseEnv({ CHAIN_ID: undefined }))).toThrow(/CHAIN_ID/)
    expect(() => loadSenseConfig(baseEnv({ RPC_URL: undefined }))).toThrow(/RPC_URL/)
    expect(() => loadSenseConfig(baseEnv({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL/)
  })

  it('rejects an unsupported chain id', () => {
    expect(() => loadSenseConfig(baseEnv({ CHAIN_ID: '1' }))).toThrow(/Unsupported CHAIN_ID/)
  })

  it('is loadable WITHOUT the signer private key (sense is secret-free)', () => {
    const config = loadSenseConfig(baseEnv({ LIQUIDATOR_PRIVATE_KEY: undefined }))
    expect(config.chainId).toBe(base.id)
  })

  it('honors an injected chain map (so a new chain is wired in one place)', () => {
    const chainMap: Record<number, ChainConfig> = {
      [base.id]: { chain: base, morpho: MORPHO, network: 'base' }
    }
    expect(loadSenseConfig(baseEnv(), { chainMap }).morpho).toBe(MORPHO)
    expect(() => loadSenseConfig(baseEnv({ CHAIN_ID: '10' }), { chainMap })).toThrow(/Unsupported/)
  })
})

describe('loadActConfig', () => {
  it('derives the Executor CREATE2 address and defaults to no swap routes', () => {
    const config: ActConfig = loadActConfig(baseEnv())
    expect(config.executooorAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(config.swapConfig).toEqual({})
    expect(config.liquidatorAddress).toBe(DERIVED)
  })

  it('parses quoting tunables with safe defaults', () => {
    const quoting: QuotingConfig = loadActConfig(baseEnv()).quoting
    expect(quoting.maxRouteImpactBps).toBe(500)
    expect(quoting.httpRps).toBe(2)
    expect(quoting.backoffBaseBlocks).toBe(2n)
  })

  it('treats an absent swap-config file as no routes (non-fatal first-deploy bootstrap)', () => {
    const config = loadActConfig(baseEnv({ SWAP_CONFIG_PATH: '/config/swap.json' }), {
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
    const config = loadActConfig(baseEnv({ SWAP_CONFIG_PATH: '/config/swap.json' }), {
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
      loadActConfig(baseEnv({ SWAP_CONFIG_PATH: '/config/swap.json' }), {
        readFile: () => JSON.stringify(swap)
      })
    ).toThrow(/ONEINCH_API_KEY/)
  })

  it('requires LIQUIDATOR_ADDRESS (act has no key to derive it from) and rejects a malformed one', () => {
    expect(() => loadActConfig(baseEnv({ LIQUIDATOR_ADDRESS: undefined }))).toThrow(
      /LIQUIDATOR_ADDRESS/
    )
    expect(() => loadActConfig(baseEnv({ LIQUIDATOR_ADDRESS: 'not-an-address' }))).toThrow(
      /LIQUIDATOR_ADDRESS is not a valid address/
    )
  })
})

describe('loadQueueConfig', () => {
  it('loads the signer key + fee ceiling for a valid config', () => {
    const config: QueueConfig = loadQueueConfig(baseEnv())
    expect(config.chainId).toBe(base.id)
    expect(config.rpcUrl).toBe('https://base.example')
    expect(config.liquidatorPrivateKey).toBe(KEY as Hex)
  })

  it('fails loud on a missing or malformed private key', () => {
    expect(() => loadQueueConfig(baseEnv({ LIQUIDATOR_PRIVATE_KEY: undefined }))).toThrow(
      /LIQUIDATOR_PRIVATE_KEY/
    )
    expect(() => loadQueueConfig(baseEnv({ LIQUIDATOR_PRIVATE_KEY: '0xdeadbeef' }))).toThrow(
      /LIQUIDATOR_PRIVATE_KEY/
    )
  })

  // The act/queue wallet-agreement gate: LIQUIDATOR_ADDRESS (act's skim recipient) must be the
  // wallet the queue's key signs for, or act-built calldata would skim seized funds to a wallet
  // this deployment's signer does not control.
  it('rejects a LIQUIDATOR_ADDRESS that does not match the key-derived signer address', () => {
    expect(() =>
      loadQueueConfig(baseEnv({ LIQUIDATOR_ADDRESS: '0x2222222222222222222222222222222222222222' }))
    ).toThrow(/does not match the address derived from LIQUIDATOR_PRIVATE_KEY/)
  })

  it('accepts a LIQUIDATOR_ADDRESS that matches the key-derived signer address', () => {
    const config = loadQueueConfig(baseEnv({ LIQUIDATOR_ADDRESS: DERIVED.toLowerCase() }))
    expect(config.liquidatorPrivateKey).toBe(KEY as Hex)
  })

  it('rejects a malformed LIQUIDATOR_ADDRESS on the queue path', () => {
    expect(() => loadQueueConfig(baseEnv({ LIQUIDATOR_ADDRESS: 'not-an-address' }))).toThrow(
      /LIQUIDATOR_ADDRESS is not a valid address/
    )
  })
})
