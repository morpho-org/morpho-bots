import type { Logger } from '@repo/evm-kit'
import type { PositionRecord } from '@repo/pipeline'
import type { Address, Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { BorrowerCandidate } from '../../src/borrowers'
import type { LensInput, LensOut } from '../../src/lens.sol'

import { lensKey } from '../../src/lens.sol'
import { findUnhealthyPositions } from '../../src/ops/unhealthy-positions'
import { formatPositionId } from '../../src/position-id'

function spyLogger() {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = []
  const make = (level: string) => (event: string, fields?: Record<string, unknown>) =>
    events.push({ level, event, fields })
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error')
  }
  return { logger, events }
}

const CHAIN_ID = 8453
const BORROWER: Address = getAddress('0x1111111111111111111111111111111111111111')
const CALLER: Address = getAddress('0x2222222222222222222222222222222222222222')
const TOKEN: Address = getAddress('0x3333333333333333333333333333333333333333')
const ORACLE: Address = getAddress('0x4444444444444444444444444444444444444444')
const ZERO = '0x0000000000000000000000000000000000000000' as const
const MARKET: Hex = `0x${'a'.repeat(64)}`
const ID = formatPositionId(CHAIN_ID, MARKET, BORROWER)

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
      chainId: 8453n,
      midnight: ZERO,
      loanToken: TOKEN,
      collateralParams: [
        {
          token: TOKEN,
          lltv: 860000000000000000n,
          liquidationCursor: 250000000000000000n,
          oracle: ORACLE
        }
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

function stubReadLens(out: LensOut | null) {
  return async (pairs: LensInput[]) => {
    const map = new Map<string, LensOut>()
    if (out) for (const pair of pairs) map.set(lensKey(pair.id, pair.borrower), out)
    return map
  }
}

function runWith(opts: {
  out?: LensOut | null
  borrowers?: Address[]
  discoverError?: Error
  chainHead?: bigint
}) {
  const { logger, events } = spyLogger()
  const emitted: PositionRecord[] = []
  return findUnhealthyPositions({
    chainId: CHAIN_ID,
    caller: CALLER,
    discover: async () => {
      if (opts.discoverError) throw opts.discoverError
      return candidates(...(opts.borrowers ?? [BORROWER]))
    },
    chainHead: opts.chainHead ?? 100n,
    readLens: stubReadLens(opts.out === undefined ? lensOut() : opts.out),
    emit: record => emitted.push(record),
    logger
  }).then(counters => ({ counters, emitted, events }))
}

describe('findUnhealthyPositions', () => {
  it('emits one fully-formed record per liquidatable, plannable position', async () => {
    const { counters, emitted } = await runWith({})
    expect(counters).toEqual({ pairs: 1, liquidatable: 1, emitted: 1 })
    const record = emitted[0]!
    expect(record.kind).toBe('position')
    expect(record.id).toBe(ID)
    expect(record.chainId).toBe(CHAIN_ID)
    expect(record.marketId).toBe(MARKET)
    expect(record.borrower).toBe(BORROWER)
    expect(record).toMatchObject({ loanToken: TOKEN, collateralToken: TOKEN, observedAtBlock: 100 })
    expect(typeof record.seizedAssets).toBe('string')
  })

  it('emits a bad-debt-realization record (a valid (0,0) plan)', async () => {
    const { counters, emitted } = await runWith({
      out: lensOut({ healthy: true, blockTimestamp: 3000n, debt: 1000n, badDebt: 1000n })
    })
    expect(counters).toEqual({ pairs: 1, liquidatable: 1, emitted: 1 })
    expect(emitted[0]).toMatchObject({ seizedAssets: '0', repaidUnits: '0' })
  })

  it('does not emit a non-liquidatable position, and logs a DEBUG source.skip', async () => {
    const { counters, emitted, events } = await runWith({ out: lensOut({ healthy: true }) })
    expect(counters).toEqual({ pairs: 1, liquidatable: 0, emitted: 0 })
    expect(emitted).toHaveLength(0)
    expect(events).toContainEqual({
      level: 'debug',
      event: 'source.skip',
      fields: { id: ID, status: 'not_liquidatable', block: 100n }
    })
  })

  it('skips a pair the lens did not return, and logs a DEBUG source.skip', async () => {
    const { counters, emitted, events } = await runWith({ out: null })
    expect(counters).toEqual({ pairs: 1, liquidatable: 0, emitted: 0 })
    expect(emitted).toHaveLength(0)
    expect(events).toContainEqual({
      level: 'debug',
      event: 'source.skip',
      fields: { id: ID, status: 'not_liquidatable', block: 100n }
    })
  })

  // The INFO-level `degenerate_plan` branch is structurally identical to blue's and is exercised by
  // blue-liquidation's collateral-less test; midnight's `plan` only returns null via a fragile
  // cap-rounds-to-zero fixture, so it is not reproduced here.

  it('tolerates a discovery failure: logs discover.error and emits nothing', async () => {
    const { counters, emitted, events } = await runWith({ discoverError: new Error('boom') })
    expect(counters).toEqual({ pairs: 0, liquidatable: 0, emitted: 0 })
    expect(emitted).toHaveLength(0)
    expect(events.some(e => e.level === 'warn' && e.event === 'discover.error')).toBe(true)
  })
})
