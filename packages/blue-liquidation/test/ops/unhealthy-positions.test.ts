import type { Logger } from '@repo/evm-kit'
import type { PositionRecord } from '@repo/pipeline'
import type { Address } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { BorrowerCandidate } from '../../src/borrowers'
import type { LensInput, LensOut } from '../../src/lens.sol'
import type { MarketParams } from '../../src/market'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { lensKey } from '../../src/lens.sol'
import { marketId } from '../../src/market'
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
const LOAN: Address = getAddress('0x3333333333333333333333333333333333333333')
const COLL: Address = getAddress('0x4444444444444444444444444444444444444444')
const ORACLE: Address = getAddress('0x5555555555555555555555555555555555555555')
const IRM: Address = getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687')

const PARAMS: MarketParams = {
  loanToken: LOAN,
  collateralToken: COLL,
  oracle: ORACLE,
  irm: IRM,
  lltv: 86n * 10n ** 16n
}
const ID = formatPositionId(CHAIN_ID, marketId(PARAMS), BORROWER)

function lensOut(overrides: Partial<LensOut> = {}): LensOut {
  return {
    params: PARAMS,
    valid: true,
    hasDebt: true,
    healthy: false,
    blockTimestamp: 1000n,
    borrowShares: 1000n * WAD * 10n ** 6n,
    collateral: 5000n * WAD,
    accruedTotalBorrowAssets: 5000n * WAD,
    totalBorrowShares: 5000n * WAD * 10n ** 6n,
    collateralPrice: ORACLE_PRICE_SCALE,
    lltv: PARAMS.lltv,
    ...overrides
  }
}

const candidates = (...borrowers: Address[]): BorrowerCandidate[] =>
  borrowers.map(borrower => ({ marketParams: PARAMS, borrower }))

function stubReadLens(out: LensOut | null) {
  return async (pairs: LensInput[]) => {
    const map = new Map<string, LensOut>()
    if (out) for (const pair of pairs) map.set(lensKey(marketId(pair.params), pair.borrower), out)
    return map
  }
}

function runWith(opts: {
  out?: LensOut | null
  borrowers?: Address[]
  synced?: bigint | null
  chainHead?: bigint
}) {
  const { logger, events } = spyLogger()
  const emitted: PositionRecord[] = []
  const chainHead = opts.chainHead ?? 100n
  return findUnhealthyPositions({
    chainId: CHAIN_ID,
    discover: async () => candidates(...(opts.borrowers ?? [BORROWER])),
    syncedBlock: async () => (opts.synced === undefined ? chainHead : opts.synced),
    chainHead,
    readLens: stubReadLens(opts.out === undefined ? lensOut() : opts.out),
    emit: record => emitted.push(record),
    logger
  }).then(counters => ({ counters, emitted, events }))
}

describe('findUnhealthyPositions', () => {
  it('emits one fully-formed opportunity per liquidatable, plannable position', async () => {
    const { counters, emitted } = await runWith({})
    expect(counters).toEqual({ pairs: 1, liquidatable: 1, emitted: 1 })
    expect(emitted).toHaveLength(1)
    const record = emitted[0]!
    expect(record.kind).toBe('position')
    expect(record.id).toBe(ID)
    expect(record.chainId).toBe(CHAIN_ID)
    expect(record.marketId).toBe(marketId(PARAMS))
    expect(record.borrower).toBe(BORROWER)
    expect(typeof record.summary).toBe('string')
    expect(record.market).toEqual({
      ...PARAMS,
      lltv: PARAMS.lltv.toString()
    })
    // Sizes ride as bare decimal strings (the wire convention).
    expect(typeof record.seizableCollateral).toBe('string')
    expect(typeof record.repayAssets).toBe('string')
  })

  it('does not emit a healthy (non-liquidatable) position', async () => {
    const { counters, emitted } = await runWith({ out: lensOut({ healthy: true }) })
    expect(counters).toEqual({ pairs: 1, liquidatable: 0, emitted: 0 })
    expect(emitted).toHaveLength(0)
  })

  it('senses but does not emit a degenerate collateral-less position (no plan)', async () => {
    const { counters, emitted } = await runWith({ out: lensOut({ collateral: 0n }) })
    expect(counters).toEqual({ pairs: 1, liquidatable: 1, emitted: 0 })
    expect(emitted).toHaveLength(0)
  })

  it('skips a pair the lens did not return', async () => {
    const { counters, emitted } = await runWith({ out: null })
    expect(counters).toEqual({ pairs: 1, liquidatable: 0, emitted: 0 })
    expect(emitted).toHaveLength(0)
  })

  it('warns rindexer.lag when the indexer trails the head, and still emits', async () => {
    const { counters, events } = await runWith({ synced: 10n, chainHead: 100n }) // lag 90 > 30
    expect(events.some(e => e.level === 'warn' && e.event === 'rindexer.lag')).toBe(true)
    expect(counters.emitted).toBe(1)
  })

  it('warns rindexer.lag reason unknown when the synced head is unavailable, and still emits', async () => {
    const { counters, events } = await runWith({ synced: null })
    expect(events.some(e => e.event === 'rindexer.lag' && e.fields?.reason === 'unknown')).toBe(
      true
    )
    expect(counters.emitted).toBe(1)
  })
})
