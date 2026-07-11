import { ConfigError } from '@repo/home'
import { describe, expect, it } from 'bun:test'

import { resolveChain } from '../src/domains'

describe('resolveChain', () => {
  it('throws ConfigError for a chain no registered domain supports', async () => {
    await expect(resolveChain(999_999)).rejects.toBeInstanceOf(ConfigError)
  })

  it('resolves Base (8453), present in both cores maps', async () => {
    const chain = await resolveChain(8453)
    expect(chain.id).toBe(8453)
  })

  it('resolves a chain present in only ONE core map via the cross-domain union scan', async () => {
    // Robinhood (4663) lives only in blue-liquidation's CHAIN_MAP (a `defineChain` custom chain);
    // the union scan across every registered domain resolves it without duplicating it here.
    const chain = await resolveChain(4663)
    expect(chain.id).toBe(4663)
  })
})
