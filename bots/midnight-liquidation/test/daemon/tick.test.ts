import type { Address, Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { ActivitySyncStatus } from '../../src/api/chains'
import type { MidnightApiClient } from '../../src/api/client'
import type { BorrowerCandidate } from '../../src/discovery/borrowers'
import type { SimulateResult } from '../../src/execution/simulate'
import type { LensInput, LensOut } from '../../src/lens/lens.sol'
import type { Logger } from '../../src/logger'

import { runTick } from '../../src/daemon/tick'
import { lensKey } from '../../src/lens/lens.sol'

const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}
const BORROWER: Address = getAddress('0x1111111111111111111111111111111111111111')
const CALLER: Address = getAddress('0x2222222222222222222222222222222222222222')
const TOKEN: Address = getAddress('0x3333333333333333333333333333333333333333')
const ORACLE: Address = getAddress('0x4444444444444444444444444444444444444444')
const ZERO = '0x0000000000000000000000000000000000000000' as const
const MARKET: Hex = `0x${'a'.repeat(64)}`

// Stub client: /chains returns one chain with the given sync status. The Phase-2 tick reads only
// the staleness gate from the API — positions/eligibility now come from the on-chain lens.
function stubApiClient(syncStatus: ActivitySyncStatus): MidnightApiClient {
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
      throw new Error(`unexpected path ${path}`)
    }
  } as unknown as MidnightApiClient
}

// A liquidatable reading: valid, gate open, has debt, unlocked, unhealthy, pre-maturity.
function lensOut(overrides: Partial<LensOut> = {}): LensOut {
  return {
    valid: true,
    hasDebt: true,
    healthy: false,
    locked: false,
    gateAllows: true,
    blockTimestamp: 1000n,
    debt: 1000n,
    maxDebt: 900n,
    badDebt: 0n,
    activatedBitmap: 1n,
    bestCollateralIdx: 0,
    bestCollateralAmt: 5000n,
    bestCollateralPrice: 10n ** 36n,
    bestCollateralMaxLif: 1100000000000000000n,
    bestCollateralLltv: 860000000000000000n,
    market: {
      loanToken: TOKEN,
      collateralParams: [
        { token: TOKEN, lltv: 860000000000000000n, maxLif: 1100000000000000000n, oracle: ORACLE }
      ],
      maturity: 2000n,
      rcfThreshold: 10n ** 30n,
      enterGate: ZERO,
      liquidatorGate: ZERO
    },
    ...overrides
  }
}

const candidates = (...borrowers: Address[]): BorrowerCandidate[] =>
  borrowers.map(borrower => ({ marketId: MARKET, borrower }))

// readLens stub: returns the same LensOut for every pair (or none, to simulate a missing row).
function stubReadLens(out: LensOut | null) {
  return async (pairs: LensInput[]) => {
    const map = new Map<string, LensOut>()
    if (out) for (const pair of pairs) map.set(lensKey(pair.id, pair.borrower), out)
    return map
  }
}

function runWith(opts: {
  syncStatus?: ActivitySyncStatus
  chainId?: number
  out?: LensOut | null
  simulateResult?: SimulateResult
  borrowers?: Address[]
}) {
  let simulateCalls = 0
  const result = runTick({
    apiClient: stubApiClient(opts.syncStatus ?? 'healthy'),
    discover: async () => candidates(...(opts.borrowers ?? [BORROWER])),
    chainId: opts.chainId ?? 8453,
    caller: CALLER,
    readLens: stubReadLens(opts.out === undefined ? lensOut() : opts.out),
    simulate: async () => {
      simulateCalls += 1
      return opts.simulateResult ?? { status: 'unfunded' }
    },
    logger: NOOP_LOGGER
  })
  return result.then(counters => ({ counters, simulateCalls: () => simulateCalls }))
}

describe('runTick', () => {
  it('plans and simulates a liquidatable pair, counting an unfunded result', async () => {
    const { counters, simulateCalls } = await runWith({ simulateResult: { status: 'unfunded' } })
    expect(counters).toEqual({
      pairs: 1,
      liquidatable: 1,
      planned: 1,
      ok: 0,
      unfunded: 1,
      reverted: 0,
      skipped: false
    })
    expect(simulateCalls()).toBe(1)
  })

  it('counts a reverting simulation as reverted', async () => {
    const { counters } = await runWith({
      simulateResult: { status: 'revert', reason: 'recovery close factor conditions violated' }
    })
    expect(counters.reverted).toBe(1)
    expect(counters.unfunded).toBe(0)
  })

  it('counts a successful simulation as ok', async () => {
    const { counters } = await runWith({ simulateResult: { status: 'ok' } })
    expect(counters.ok).toBe(1)
  })

  it('skips a non-liquidatable pair without simulating', async () => {
    const { counters, simulateCalls } = await runWith({ out: lensOut({ healthy: true }) })
    expect(counters).toMatchObject({ pairs: 1, liquidatable: 0, planned: 0 })
    expect(simulateCalls()).toBe(0)
  })

  it('skips a pair the lens did not return', async () => {
    const { counters, simulateCalls } = await runWith({ out: null })
    expect(counters).toMatchObject({ pairs: 1, liquidatable: 0 })
    expect(simulateCalls()).toBe(0)
  })

  it('skips the whole tick when the indexer is behind', async () => {
    const { counters, simulateCalls } = await runWith({ syncStatus: 'behind' })
    expect(counters.skipped).toBe(true)
    expect(simulateCalls()).toBe(0)
  })

  it('skips when our chain is absent from the indexer status', async () => {
    const { counters } = await runWith({ chainId: 999999 })
    expect(counters.skipped).toBe(true)
  })
})
