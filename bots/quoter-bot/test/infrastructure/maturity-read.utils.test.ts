import type { Hex } from 'viem'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { BootstrapAdapterError } from '../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { maturityReadsByMarket } from '../../src/infrastructure/maturity-read.utils'

const marketId: Hex = `0x${'55'.repeat(32)}`
const secondMarketId: Hex = `0x${'66'.repeat(32)}`
const maturity = 1_760_000_000n
const blockTimestamp = 1_750_000_000n

const premiumEntry = (id: Hex) => ({
  marketId: id,
  maturityPremium: { shape: 'linear' as const, premiumPerYearBps: 120n }
})

const harness = () => {
  let marketReads = 0
  let blockReads = 0
  let failMarket = false
  return {
    counts: () => ({ marketReads, blockReads }),
    setFailMarket: (value: boolean) => (failMarket = value),
    midnight: {
      async getMarketData(requested: Hex) {
        marketReads++
        if (failMarket) throw new Error('market unavailable')
        return {
          timeToMaturity: (timestamp: bigint) =>
            requested === marketId ? maturity - timestamp : 999n
        }
      }
    },
    client: {
      async getBlock(_parameters: { blockTag: 'latest' }) {
        blockReads++
        return { timestamp: blockTimestamp }
      }
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('maturityReadsByMarket', () => {
  test('builds SDK-derived readers only for entries configuring a maturity premium', async () => {
    const providers = harness()
    const reads = maturityReadsByMarket({
      entries: [premiumEntry(marketId), { marketId: secondMarketId }],
      midnight: providers.midnight,
      client: providers.client
    })

    expect(reads.has(secondMarketId)).toBe(false)
    expect(await reads.get(marketId)?.()).toBe(maturity - blockTimestamp)
  })

  test('caches immutable market data and shares one block read across a cycle sweep', async () => {
    const providers = harness()
    const reads = maturityReadsByMarket({
      entries: [premiumEntry(marketId), premiumEntry(secondMarketId)],
      midnight: providers.midnight,
      client: providers.client
    })

    await reads.get(marketId)?.()
    await reads.get(secondMarketId)?.()
    await reads.get(marketId)?.()

    expect(providers.counts()).toEqual({ marketReads: 2, blockReads: 1 })
  })

  test('refreshes the shared block read after the share window elapses', async () => {
    const providers = harness()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(0)
    const reads = maturityReadsByMarket({
      entries: [premiumEntry(marketId)],
      midnight: providers.midnight,
      client: providers.client
    })

    await reads.get(marketId)?.()
    now.mockReturnValue(60_000)
    await reads.get(marketId)?.()

    expect(providers.counts()).toEqual({ marketReads: 1, blockReads: 2 })
  })

  test('wraps a failed read in the stable adapter classification and retries after eviction', async () => {
    const providers = harness()
    providers.setFailMarket(true)
    const reads = maturityReadsByMarket({
      entries: [premiumEntry(marketId)],
      midnight: providers.midnight,
      client: providers.client
    })

    const error = await reads
      .get(marketId)?.()
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ name: 'BootstrapAdapterError', operation: 'maturity-read' })

    providers.setFailMarket(false)
    expect(await reads.get(marketId)?.()).toBe(maturity - blockTimestamp)
    expect(providers.counts().marketReads).toBe(2)
  })
})
