import { ConfigError } from '@repo/home'
import { describe, expect, it } from 'bun:test'
import { base } from 'viem/chains'

import { resolveChain, resolveChainId, resolveConfig } from '../src/config'

const LIQUIDATOR_ADDRESS = '0x1111111111111111111111111111111111111111'

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

describe('resolveChain', () => {
  it('builds a generic viem chain from explicit id and RPC URL', () => {
    const chain = resolveChain('4663', { RPC_URL: 'https://rpc.example' })
    expect(chain.id).toBe(4663)
    expect(chain.rpcUrls.default.http).toEqual(['https://rpc.example'])
  })

  it('rejects invalid ids and missing RPC configuration', () => {
    expect(() => resolveChain('nope', { RPC_URL: 'https://rpc.example' })).toThrow(/CHAIN_ID/)
    expect(() => resolveChain('8453', {})).toThrow(/RPC_URL/)
  })
})

describe('resolveConfig', () => {
  const base8453 = { env: {}, chain: base, chainId: '8453', opts: {}, home: '' }

  it('requires RPC_URL', () => {
    expect(() => resolveConfig({ ...base8453, env: { SIGNER_SOCKET: '/tmp/s.sock' } })).toThrow(
      /RPC_URL/
    )
  })

  it('rethrows a bad MAX_FEE_GWEI as ConfigError (operator misconfig → exit 2)', () => {
    expect(() =>
      resolveConfig({
        ...base8453,
        env: { RPC_URL: 'http://base', SIGNER_SOCKET: '/tmp/s.sock', MAX_FEE_GWEI: 'abc' }
      })
    ).toThrow(ConfigError)
  })

  it('requires a signer socket when armed', () => {
    expect(() => resolveConfig({ ...base8453, env: { RPC_URL: 'http://base' } })).toThrow(
      ConfigError
    )
  })

  it('resolves an agent-backed armed config with defaults', () => {
    const config = resolveConfig({
      ...base8453,
      env: { RPC_URL: 'http://base', SIGNER_SOCKET: '/tmp/s.sock', LIQUIDATOR_ADDRESS }
    })
    expect(config.chainId).toBe(8453)
    expect(config.dryRun).toBe(false)
    expect(config.signer?.kind).toBe('agent')
    expect(config.stuckBlocks).toBe(4n) // default
  })

  it('never reads a key in dry-run (signer undefined)', () => {
    const config = resolveConfig({
      ...base8453,
      opts: { dryRun: true },
      env: { RPC_URL: 'http://base', LIQUIDATOR_ADDRESS }
    })
    expect(config.dryRun).toBe(true)
    expect(config.signer).toBeUndefined()
  })

  it('selects the agent backend when SIGNER_SOCKET is set', () => {
    const config = resolveConfig({
      ...base8453,
      env: { RPC_URL: 'http://base', SIGNER_SOCKET: '/tmp/s.sock', LIQUIDATOR_ADDRESS }
    })
    expect(config.signer?.kind).toBe('agent')
  })

  it('rejects local private-key material in armed mode', () => {
    expect(() =>
      resolveConfig({
        ...base8453,
        env: {
          RPC_URL: 'http://base',
          SIGNER_SOCKET: '/tmp/s.sock',
          LIQUIDATOR_PRIVATE_KEY: '0xdeadbeef'
        }
      })
    ).toThrow(/not accepted by morpho-queued/)
  })

  it('validates STUCK_BLOCKS as a positive integer', () => {
    expect(() =>
      resolveConfig({
        ...base8453,
        env: { RPC_URL: 'http://base', SIGNER_SOCKET: '/tmp/s.sock', STUCK_BLOCKS: '0' }
      })
    ).toThrow(/STUCK_BLOCKS/)
    const config = resolveConfig({
      ...base8453,
      env: {
        RPC_URL: 'http://base',
        SIGNER_SOCKET: '/tmp/s.sock',
        LIQUIDATOR_ADDRESS,
        STUCK_BLOCKS: '9'
      }
    })
    expect(config.stuckBlocks).toBe(9n)
  })
})
