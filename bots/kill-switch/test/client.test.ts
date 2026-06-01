import { describe, expect, it } from 'bun:test'
import { base, mainnet } from 'viem/chains'

import { createBotClient, resolveChain } from '../src/client'
import { config } from './fixtures/config'

describe('resolveChain', () => {
  it('resolves supported chain ids', () => {
    expect(resolveChain(mainnet.id)).toBe(mainnet)
    expect(resolveChain(base.id)).toBe(base)
  })

  it('throws on an unsupported chain id', () => {
    expect(() => resolveChain(999_999)).toThrow()
  })
})

describe('createBotClient', () => {
  it('builds a public client for the configured chain', () => {
    const client = createBotClient(config.chain)
    expect(client.chain?.id).toBe(config.chain.id)
  })
})
