import type { Address, Hex } from 'viem'

import { describe, expect, it } from 'bun:test'

import type { ActivitySyncStatus } from '../../src/api/chains'
import type { MidnightApiClient } from '../../src/api/client'
import type { BorrowerCandidate } from '../../src/discovery/borrowers'
import type { Logger } from '../../src/logger'

import { runDryRunTick } from '../../src/daemon/tick'

const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}
const BORROWER: Address = '0x1111111111111111111111111111111111111111'
const MARKET: Hex = `0x${'a'.repeat(64)}`

// Stub client: /chains returns one chain with the given sync status; /positions returns `positions`.
function stubClient(
  syncStatus: ActivitySyncStatus,
  positions: { market_id: string; debt: string }[]
) {
  return {
    GET: async (path: string) => {
      if (path === '/v1/midnight/chains') {
        return {
          data: {
            data: [
              {
                chain_id: 8453,
                name: 'base',
                latest_indexed_block: { number: '100', hash: '0x' },
                activity_sync_status: { status: syncStatus, pipelines: [] }
              }
            ]
          },
          response: new Response(null, { status: 200 })
        }
      }
      return {
        data: { cursor: null, data: positions },
        response: new Response(null, { status: 200 })
      }
    }
  } as unknown as MidnightApiClient
}

const candidates = (...borrowers: Address[]): BorrowerCandidate[] =>
  borrowers.map(borrower => ({ marketId: MARKET, borrower }))

describe('runDryRunTick', () => {
  it('logs a would-attempt per borrow position when the indexer is healthy', async () => {
    const result = await runDryRunTick({
      apiClient: stubClient('healthy', [{ market_id: MARKET, debt: '500' }]),
      discover: async () => candidates(BORROWER),
      chainId: 8453,
      logger: NOOP_LOGGER
    })
    expect(result).toEqual({ borrowers: 1, positions: 1, skipped: false })
  })

  it('dedupes borrowers seen across multiple markets', async () => {
    const result = await runDryRunTick({
      apiClient: stubClient('healthy', []),
      discover: async () => candidates(BORROWER, BORROWER),
      chainId: 8453,
      logger: NOOP_LOGGER
    })
    expect(result.borrowers).toBe(1)
  })

  it('skips the tick when the indexer is behind', async () => {
    const result = await runDryRunTick({
      apiClient: stubClient('behind', [{ market_id: MARKET, debt: '500' }]),
      discover: async () => candidates(BORROWER),
      chainId: 8453,
      logger: NOOP_LOGGER
    })
    expect(result).toEqual({ borrowers: 0, positions: 0, skipped: true })
  })

  it('skips when our chain is absent from the indexer status', async () => {
    const result = await runDryRunTick({
      apiClient: stubClient('healthy', []),
      discover: async () => candidates(BORROWER),
      chainId: 999999,
      logger: NOOP_LOGGER
    })
    expect(result.skipped).toBe(true)
  })
})
