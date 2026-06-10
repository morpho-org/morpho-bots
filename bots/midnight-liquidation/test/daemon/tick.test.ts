import type { Address, Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { BorrowerCandidate } from '../../src/discovery/borrowers'
import type { SimulateResult } from '../../src/execution/simulate'
import type { LensInput, LensOut } from '../../src/lens/lens.sol'
import type { Logger } from '../../src/logger'

import { runTick } from '../../src/daemon/tick'
import { lensKey } from '../../src/lens/lens.sol'

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

const BORROWER: Address = getAddress('0x1111111111111111111111111111111111111111')
const CALLER: Address = getAddress('0x2222222222222222222222222222222222222222')
const TOKEN: Address = getAddress('0x3333333333333333333333333333333333333333')
const ORACLE: Address = getAddress('0x4444444444444444444444444444444444444444')
const ZERO = '0x0000000000000000000000000000000000000000' as const
const MARKET: Hex = `0x${'a'.repeat(64)}`
const LABEL = lensKey(MARKET, BORROWER)

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

function stubReadLens(out: LensOut | null) {
  return async (pairs: LensInput[]) => {
    const map = new Map<string, LensOut>()
    if (out) for (const pair of pairs) map.set(lensKey(pair.id, pair.borrower), out)
    return map
  }
}

function runWith(opts: {
  out?: LensOut | null
  simulateResult?: SimulateResult
  borrowers?: Address[]
  synced?: bigint | null
  chainHead?: bigint
  inflight?: ReadonlySet<string>
}) {
  const { logger, events } = spyLogger()
  let simulateCalls = 0
  let submitCalls = 0
  let onBlockCalls = 0
  const chainHead = opts.chainHead ?? 100n
  const result = runTick({
    discover: async () => candidates(...(opts.borrowers ?? [BORROWER])),
    syncedBlock: async () => (opts.synced === undefined ? chainHead : opts.synced),
    chainHead,
    caller: CALLER,
    readLens: stubReadLens(opts.out === undefined ? lensOut() : opts.out),
    simulate: async () => {
      simulateCalls += 1
      return opts.simulateResult ?? { status: 'unfunded' }
    },
    submit: async () => {
      submitCalls += 1
    },
    pendingOnBlock: async () => {
      onBlockCalls += 1
    },
    inflightLabels: () => opts.inflight ?? new Set(),
    logger
  })
  return result.then(counters => ({
    counters,
    simulateCalls: () => simulateCalls,
    submitCalls: () => submitCalls,
    onBlockCalls: () => onBlockCalls,
    events
  }))
}

describe('runTick', () => {
  it('plans, simulates, and submits a liquidatable pair (unfunded is still submittable)', async () => {
    const { counters, simulateCalls, submitCalls, onBlockCalls } = await runWith({
      simulateResult: { status: 'unfunded' }
    })
    expect(counters).toEqual({
      pairs: 1,
      liquidatable: 1,
      planned: 1,
      ok: 0,
      unfunded: 1,
      reverted: 0,
      submitted: 1
    })
    expect(simulateCalls()).toBe(1)
    expect(submitCalls()).toBe(1)
    expect(onBlockCalls()).toBe(1) // pendingOnBlock runs every tick
  })

  it('submits on a successful simulation', async () => {
    const { counters, submitCalls } = await runWith({ simulateResult: { status: 'ok' } })
    expect(counters.ok).toBe(1)
    expect(counters.submitted).toBe(1)
    expect(submitCalls()).toBe(1)
  })

  it('does not submit a reverting plan (a Midnight sizing/eligibility error)', async () => {
    const { counters, submitCalls } = await runWith({
      simulateResult: { status: 'revert', reason: 'RecoveryCloseFactorConditionsViolated' }
    })
    expect(counters.reverted).toBe(1)
    expect(counters.submitted).toBe(0)
    expect(submitCalls()).toBe(0)
  })

  it('skips a position already in flight without re-simulating or submitting', async () => {
    const { counters, simulateCalls, submitCalls } = await runWith({ inflight: new Set([LABEL]) })
    expect(counters).toMatchObject({ liquidatable: 1, planned: 0, submitted: 0 })
    expect(simulateCalls()).toBe(0)
    expect(submitCalls()).toBe(0)
  })

  it('skips a non-liquidatable pair without simulating or submitting', async () => {
    const { counters, simulateCalls, submitCalls } = await runWith({
      out: lensOut({ healthy: true })
    })
    expect(counters).toMatchObject({ pairs: 1, liquidatable: 0, planned: 0, submitted: 0 })
    expect(simulateCalls()).toBe(0)
    expect(submitCalls()).toBe(0)
  })

  it('skips a pair the lens did not return', async () => {
    const { counters, submitCalls } = await runWith({ out: null })
    expect(counters).toMatchObject({ pairs: 1, liquidatable: 0, submitted: 0 })
    expect(submitCalls()).toBe(0)
  })

  it('warns rindexer.lag when our indexer trails the chain head, but still proceeds', async () => {
    const { counters, events } = await runWith({ synced: 10n, chainHead: 100n }) // lag 90 > 30
    expect(events.some(e => e.level === 'warn' && e.event === 'rindexer.lag')).toBe(true)
    expect(counters.submitted).toBe(1) // proceeded despite the lag
  })

  it('warns rindexer.lag with reason unknown when the synced head is unavailable, and proceeds', async () => {
    const { counters, events } = await runWith({ synced: null })
    expect(events.some(e => e.event === 'rindexer.lag' && e.fields?.reason === 'unknown')).toBe(
      true
    )
    expect(counters.submitted).toBe(1)
  })
})
