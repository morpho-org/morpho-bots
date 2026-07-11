import { ConfigError } from '@repo/home'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base } from 'viem/chains'

import { mergedQueuedEnv, resolveChainId, resolveConfig } from '../src/config'

// A throwaway well-known test key (anvil account #0), never used to hold funds.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'q-cfg-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('resolveChainId', () => {
  it('prefers --chain over CHAIN_ID', () => {
    expect(resolveChainId({ chain: '8453' }, { CHAIN_ID: '1' })).toBe('8453')
  })
  it('falls back to CHAIN_ID', () => {
    expect(resolveChainId({}, { CHAIN_ID: '8453' })).toBe('8453')
  })
  it('throws ConfigError when neither is set (no sole-chain inference)', () => {
    expect(() => resolveChainId({}, {})).toThrow(ConfigError)
  })
})

describe('mergedQueuedEnv', () => {
  it('merges queued.defaults → queued.chains overlay → process env, later wins', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        queued: {
          defaults: { RPC_URL: 'http://default', MAX_FEE_GWEI: '100' },
          chains: { '8453': { RPC_URL: 'http://base' } }
        }
      })
    )
    const env = mergedQueuedEnv({ home, chainId: '8453', processEnv: { MAX_FEE_GWEI: '200' } })
    expect(env.RPC_URL).toBe('http://base') // chain overlay beats defaults
    expect(env.MAX_FEE_GWEI).toBe('200') // process env beats files
    expect(env.CHAIN_ID).toBe('8453')
  })

  it('ignores foreign-chain overlays', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ queued: { chains: { '1': { RPC_URL: 'http://mainnet' } } } })
    )
    const env = mergedQueuedEnv({ home, chainId: '8453', processEnv: {} })
    expect(env.RPC_URL).toBeUndefined()
  })

  it('rejects a malformed queued section (fail loudly, not a blind cast)', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ queued: ['not', 'an', 'object'] }))
    expect(() => mergedQueuedEnv({ home, chainId: '8453', processEnv: {} })).toThrow(ConfigError)
  })

  it('rejects a queued section whose defaults is not an object', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ queued: { defaults: 'nope' } }))
    expect(() => mergedQueuedEnv({ home, chainId: '8453', processEnv: {} })).toThrow(ConfigError)
  })
})

describe('resolveConfig', () => {
  const base8453 = { env: {}, chain: base, chainId: '8453', opts: {}, home: '' }

  it('requires RPC_URL', () => {
    expect(() => resolveConfig({ ...base8453, env: { LIQUIDATOR_PRIVATE_KEY: KEY } })).toThrow(
      /RPC_URL/
    )
  })

  it('rethrows a bad MAX_FEE_GWEI as ConfigError (operator misconfig → exit 2)', () => {
    expect(() =>
      resolveConfig({
        ...base8453,
        env: { RPC_URL: 'http://base', LIQUIDATOR_PRIVATE_KEY: KEY, MAX_FEE_GWEI: 'abc' }
      })
    ).toThrow(ConfigError)
  })

  it('rethrows a missing signing key as ConfigError (armed, no key, no socket → exit 2)', () => {
    expect(() => resolveConfig({ ...base8453, env: { RPC_URL: 'http://base' } })).toThrow(
      ConfigError
    )
  })

  it('resolves a local-key armed config with defaults', () => {
    const config = resolveConfig({
      ...base8453,
      env: { RPC_URL: 'http://base', LIQUIDATOR_PRIVATE_KEY: KEY }
    })
    expect(config.chainId).toBe(8453)
    expect(config.dryRun).toBe(false)
    expect(config.signer?.kind).toBe('local')
    expect(config.stuckBlocks).toBe(4n) // default
    expect(config.sendRpcUrl).toBeUndefined()
  })

  it('never reads a key in dry-run (signer undefined)', () => {
    const config = resolveConfig({
      ...base8453,
      opts: { dryRun: true },
      env: { RPC_URL: 'http://base' }
    })
    expect(config.dryRun).toBe(true)
    expect(config.signer).toBeUndefined()
  })

  it('selects the agent backend when SIGNER_SOCKET is set', () => {
    const config = resolveConfig({
      ...base8453,
      env: { RPC_URL: 'http://base', SIGNER_SOCKET: '/tmp/s.sock' }
    })
    expect(config.signer?.kind).toBe('agent')
  })

  it('validates STUCK_BLOCKS as a positive integer', () => {
    expect(() =>
      resolveConfig({
        ...base8453,
        env: { RPC_URL: 'http://base', LIQUIDATOR_PRIVATE_KEY: KEY, STUCK_BLOCKS: '0' }
      })
    ).toThrow(/STUCK_BLOCKS/)
    const config = resolveConfig({
      ...base8453,
      env: { RPC_URL: 'http://base', LIQUIDATOR_PRIVATE_KEY: KEY, STUCK_BLOCKS: '9' }
    })
    expect(config.stuckBlocks).toBe(9n)
  })

  it('carries SEND_RPC_URL and RPC_URL_FALLBACK when set', () => {
    const config = resolveConfig({
      ...base8453,
      env: {
        RPC_URL: 'http://base',
        RPC_URL_FALLBACK: 'http://backup',
        SEND_RPC_URL: 'http://send',
        LIQUIDATOR_PRIVATE_KEY: KEY
      }
    })
    expect(config.rpcUrlFallback).toBe('http://backup')
    expect(config.sendRpcUrl).toBe('http://send')
  })
})
