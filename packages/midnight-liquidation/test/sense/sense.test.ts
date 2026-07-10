import type { Logger, OpportunityRecord } from '@repo/bot-kit'
import type { Address, Hex } from 'viem'

import { WIRE_VERSION } from '@repo/bot-kit'
import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { BorrowerCandidate } from '../../src/discovery/borrowers'
import type { LensInput, LensOut } from '../../src/state/lens.sol'

import { runSense } from '../../src/sense/sense'
import { lensKey } from '../../src/state/lens.sol'
import { formatOpportunityId } from '../../src/wire'

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
const ID = formatOpportunityId(CHAIN_ID, MARKET, BORROWER)

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
  const emitted: OpportunityRecord[] = []
  return runSense({
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

describe('runSense', () => {
  it('emits one fully-formed opportunity per liquidatable, plannable position', async () => {
    const { counters, emitted } = await runWith({})
    expect(counters).toEqual({ pairs: 1, liquidatable: 1, emitted: 1 })
    const record = emitted[0]!
    expect(record.v).toBe(WIRE_VERSION)
    expect(record.kind).toBe('opportunity')
    expect(record.id).toBe(ID)
    expect(record.domain).toBe('midnight')
    expect(record.op).toBe('unhealthy-positions')
    expect(record.chainId).toBe(CHAIN_ID)
    expect(record.data).toMatchObject({ loanToken: TOKEN, collateralToken: TOKEN, block: 100 })
    expect(typeof record.data?.seizedAssets).toBe('string')
  })

  it('emits a bad-debt-realization opportunity (a valid (0,0) plan)', async () => {
    const { counters, emitted } = await runWith({
      out: lensOut({ healthy: true, blockTimestamp: 3000n, debt: 1000n, badDebt: 1000n })
    })
    expect(counters).toEqual({ pairs: 1, liquidatable: 1, emitted: 1 })
    expect(emitted[0]!.data).toMatchObject({ seizedAssets: '0', repaidUnits: '0' })
  })

  it('does not emit a non-liquidatable (healthy, pre-maturity) position', async () => {
    const { counters, emitted } = await runWith({ out: lensOut({ healthy: true }) })
    expect(counters).toEqual({ pairs: 1, liquidatable: 0, emitted: 0 })
    expect(emitted).toHaveLength(0)
  })

  it('skips a pair the lens did not return', async () => {
    const { counters, emitted } = await runWith({ out: null })
    expect(counters).toEqual({ pairs: 1, liquidatable: 0, emitted: 0 })
    expect(emitted).toHaveLength(0)
  })

  it('tolerates a discovery failure: logs discover.error and emits nothing', async () => {
    const { counters, emitted, events } = await runWith({ discoverError: new Error('boom') })
    expect(counters).toEqual({ pairs: 0, liquidatable: 0, emitted: 0 })
    expect(emitted).toHaveLength(0)
    expect(events.some(e => e.level === 'warn' && e.event === 'discover.error')).toBe(true)
  })
})
