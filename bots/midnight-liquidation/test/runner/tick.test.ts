import type { Logger, SimulateResult, SubmitOutcome } from '@repo/bot-kit'
import type { CooldownStore } from '@repo/bot-kit'
import type { QuoteOutcome, SwapPlan } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { createBackoff, createCooldownStore, TxSendError } from '@repo/bot-kit'
import { lensKey } from '@repo/utils'
import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { BorrowerCandidate } from '../../src/discovery/borrowers'
import type { LensInput, LensOut } from '../../src/state/lens.sol'

import { runTick } from '../../src/runner/tick'

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

// The sums documented on TickCounters. Asserted rather than eyeballed so a new loop exit that forgets
// its counter fails a test instead of silently dropping a position from the tally.
const expectCounterIdentities = (c: Record<string, number>) => {
  expect(c.pairs).toBeGreaterThanOrEqual(c.liquidatable!)
  expect(c.liquidatable).toBe(c.inflightSkipped! + c.planSkipped! + c.planned!)
  expect(c.planned).toBe(
    c.cooledDown! +
      c.backoffSkipped! +
      c.noSwapPath! +
      c.quoteFailed! +
      c.quoteUnprofitable! +
      c.ok! +
      c.reverted!
  )
  expect(c.ok).toBe(c.submitted! + c.notSent!)
}

const BORROWER: Address = getAddress('0x1111111111111111111111111111111111111111')
const CALLER: Address = getAddress('0x2222222222222222222222222222222222222222')
const TOKEN: Address = getAddress('0x3333333333333333333333333333333333333333')
const ORACLE: Address = getAddress('0x4444444444444444444444444444444444444444')
const ROUTER: Address = getAddress('0x5555555555555555555555555555555555555555')
const ZERO = '0x0000000000000000000000000000000000000000' as const
const MARKET: Hex = `0x${'a'.repeat(64)}`
const LABEL = lensKey(MARKET, BORROWER)
// 3.63% incentive → a 349bps headroom ceiling; the ramp reaches 3bps about 30s past maturity.
const WAD_ONE = 10n ** 18n
const MAX_LIF = 1036269430051813471n

const SWAP_PLAN: SwapPlan = {
  steps: [
    {
      tokenIn: TOKEN,
      tokenOut: TOKEN,
      target: ROUTER,
      value: 0n,
      callData: '0xabcdef',
      amountIn: { source: 'balance', offset: 132n },
      approvalSpender: ROUTER
    }
  ],
  expectedAmountOut: 2000n,
  amountOutMinimum: 1n
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

// Per-borrower readings, so one tick can hold candidates with different surpluses / loan tokens.
function stubReadLensByBorrower(byBorrower: Map<Address, LensOut>) {
  return async (pairs: LensInput[]) => {
    const map = new Map<string, LensOut>()
    for (const pair of pairs) {
      const out = byBorrower.get(pair.borrower)
      if (out) map.set(lensKey(pair.id, pair.borrower), out)
    }
    return map
  }
}

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
  quoteOutcome?: QuoteOutcome
  borrowers?: Address[]
  discoverError?: Error
  chainHead?: bigint
  inflight?: ReadonlySet<string>
  noSwap?: boolean
  seedBackoffAt?: bigint
  headroomFloorBps?: number
  minSurplusBps?: number
  cooldown?: CooldownStore
  /** Models the queue's outcome; the two no-broadcast reasons are NOT interchangeable. */
  submitOutcome?: SubmitOutcome
  /** Models a send that claimed a nonce but produced no hash, which aborts the tick. */
  submitThrows?: Error
  /** Distinct readings per borrower, for ordering cases. Overrides `out`. */
  outsByBorrower?: Map<Address, LensOut>
  /** Defaults to an identity valuation, so surplusUsd tracks surplus and ordering is deterministic. */
  usdValueOf?: (loanToken: Address, loanUnits: bigint) => bigint | null
}) {
  const { logger, events } = spyLogger()
  const order: Address[] = []
  let simulateCalls = 0
  let submitCalls = 0
  let quoteCalls = 0
  const chainHead = opts.chainHead ?? 100n
  const backoff = createBackoff({ baseBlocks: 2n, maxBlocks: 64n })
  if (opts.seedBackoffAt !== undefined) backoff.record(LABEL, opts.seedBackoffAt)
  // Default disabled (0) so existing cases are unaffected; opt-in cases pass an enabled store.
  const cooldown = opts.cooldown ?? createCooldownStore({ cooldownMs: 0 })
  const defaultOutcome: QuoteOutcome = opts.noSwap
    ? { kind: 'no_config' }
    : { kind: 'swap', plan: SWAP_PLAN }
  const result = runTick({
    discover: async () => {
      if (opts.discoverError) throw opts.discoverError
      return candidates(...(opts.borrowers ?? [BORROWER]))
    },
    chainHead,
    caller: CALLER,
    seizeCapMarginBps: 0,
    headroomFloorBps: opts.headroomFloorBps ?? 0,
    minSurplusBps: opts.minSurplusBps ?? 0,
    readLens: opts.outsByBorrower
      ? stubReadLensByBorrower(opts.outsByBorrower)
      : stubReadLens(opts.out === undefined ? lensOut() : opts.out),
    quoteFor: async (_plan, _out, label) => {
      quoteCalls += 1
      order.push(getAddress(`0x${label.slice(-40)}`))
      return opts.quoteOutcome ?? defaultOutcome
    },
    simulate: async () => {
      simulateCalls += 1
      return opts.simulateResult ?? { status: 'ok' }
    },
    submit: async () => {
      submitCalls += 1
      if (opts.submitThrows) throw opts.submitThrows
      return opts.submitOutcome ?? { sent: true }
    },
    backoff,
    cooldown,
    inflightLabels: () => opts.inflight ?? new Set(),
    usdValueOf: opts.usdValueOf ?? ((_loanToken, loanUnits) => loanUnits),
    logger
  })
  return result.then(counters => ({
    counters,
    backoff,
    cooldown,
    simulateCalls: () => simulateCalls,
    submitCalls: () => submitCalls,
    quoteCalls: () => quoteCalls,
    order,
    events
  }))
}

describe('runTick', () => {
  it('plans, quotes, simulates, and submits a liquidatable pair on a successful sim', async () => {
    const { counters, simulateCalls, submitCalls } = await runWith({
      simulateResult: { status: 'ok' }
    })
    expect(counters).toEqual({
      pairs: 1,
      liquidatable: 1,
      inflightSkipped: 0,
      planSkipped: 0,
      planned: 1,
      cooledDown: 0,
      backoffSkipped: 0,
      noSwapPath: 0,
      quoteFailed: 0,
      quoteUnprofitable: 0,
      ok: 1,
      reverted: 0,
      submitted: 1,
      notSent: 0,
      unpriced: 0
    })
    expect(simulateCalls()).toBe(1)
    expect(submitCalls()).toBe(1)
  })

  it('does not submit a reverting plan and backs the position off', async () => {
    const { counters, submitCalls, backoff } = await runWith({
      simulateResult: { status: 'revert', reason: 'amountOutMinimum not met' }
    })
    expect(counters.reverted).toBe(1)
    expect(counters.submitted).toBe(0)
    expect(submitCalls()).toBe(0)
    expect(backoff.shouldSkip(LABEL, 100n)).toBe(true)
  })

  it('skips with config.no_swap_path when no swap config covers the collateral (no backoff)', async () => {
    const { counters, simulateCalls, submitCalls, events, backoff } = await runWith({
      noSwap: true
    })
    expect(counters).toMatchObject({
      liquidatable: 1,
      planned: 1,
      noSwapPath: 1,
      quoteFailed: 0,
      quoteUnprofitable: 0,
      submitted: 0
    })
    expect(simulateCalls()).toBe(0) // skipped before simulating
    expect(submitCalls()).toBe(0)
    expect(events.some(e => e.event === 'config.no_swap_path')).toBe(true)
    expect(backoff.shouldSkip(LABEL, 100n)).toBe(false) // unconfigured ≠ failure
  })

  it('counts a failed quote, backs the position off, and never simulates', async () => {
    const { counters, simulateCalls, submitCalls, backoff } = await runWith({
      quoteOutcome: { kind: 'failed', reason: 'no_route' }
    })
    expect(counters).toMatchObject({ liquidatable: 1, planned: 1, quoteFailed: 1, submitted: 0 })
    expect(simulateCalls()).toBe(0)
    expect(submitCalls()).toBe(0)
    expect(backoff.shouldSkip(LABEL, 100n)).toBe(true)
  })

  it('suppresses a backed-off position without quoting or simulating', async () => {
    // Seeded a failure at block 100 (cooldown until 102); this tick at 101 must skip.
    const { counters, quoteCalls, simulateCalls } = await runWith({
      chainHead: 101n,
      seedBackoffAt: 100n
    })
    expect(counters).toMatchObject({ liquidatable: 1, backoffSkipped: 1, submitted: 0 })
    expect(quoteCalls()).toBe(0)
    expect(simulateCalls()).toBe(0)
  })

  it('clears backoff on a successful submit', async () => {
    const { backoff } = await runWith({ seedBackoffAt: 1n, simulateResult: { status: 'ok' } })
    // Seeded at block 1 (cooldown until 3) so it didn't suppress this tick at 100; the submit clears it.
    expect(backoff.shouldSkip(LABEL, 1n)).toBe(false)
  })

  it('simulates and submits fully bad-debt realization without quoting', async () => {
    const { counters, simulateCalls, submitCalls, quoteCalls } = await runWith({
      out: lensOut({
        healthy: true,
        blockTimestamp: 3000n,
        debt: 1000n,
        badDebt: 1000n,
        market: { ...lensOut().market, maturity: 2000n }
      })
    })
    expect(counters).toMatchObject({
      liquidatable: 1,
      planned: 1,
      noSwapPath: 0,
      quoteFailed: 0,
      quoteUnprofitable: 0,
      submitted: 1
    })
    expect(quoteCalls()).toBe(0) // bad-debt realization never quotes
    expect(simulateCalls()).toBe(1)
    expect(submitCalls()).toBe(1)
  })

  it('skips a position already in flight without re-quoting, simulating, or submitting', async () => {
    const { counters, quoteCalls, simulateCalls, submitCalls } = await runWith({
      inflight: new Set([LABEL])
    })
    expect(counters).toMatchObject({ liquidatable: 1, planned: 0, submitted: 0 })
    expect(quoteCalls()).toBe(0)
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

  it('tolerates a discovery failure: logs discover.error and submits nothing', async () => {
    const { counters, events, submitCalls } = await runWith({
      discoverError: new Error('boom')
    })
    expect(counters).toMatchObject({ pairs: 0, liquidatable: 0, submitted: 0 })
    expect(events.some(e => e.level === 'warn' && e.event === 'discover.error')).toBe(true)
    expect(submitCalls()).toBe(0)
  })

  describe('position cooldown (opt-in)', () => {
    it('skips a cooled-down position without quoting or simulating, counting cooledDown', async () => {
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      cooldown.mark(LABEL) // pre-marked as if a prior tick failed
      const { counters, quoteCalls, simulateCalls, submitCalls, events } = await runWith({
        cooldown
      })
      expect(counters).toMatchObject({ liquidatable: 1, cooledDown: 1, submitted: 0 })
      expect(quoteCalls()).toBe(0)
      expect(simulateCalls()).toBe(0)
      expect(submitCalls()).toBe(0)
      expect(events.some(e => e.event === 'cooldown.skip')).toBe(true)
    })

    it('marks the position on a failed quote so the next tick cools it down', async () => {
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      const { counters } = await runWith({
        cooldown,
        quoteOutcome: { kind: 'failed', reason: 'no_route' }
      })
      expect(counters.quoteFailed).toBe(1)
      expect(cooldown.shouldSkip(LABEL)).toBe(true)
    })

    it('marks the position on a no_swap_path outcome', async () => {
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      const { counters } = await runWith({ cooldown, noSwap: true })
      expect(counters.noSwapPath).toBe(1)
      expect(cooldown.shouldSkip(LABEL)).toBe(true)
    })

    it('marks the position on a sim revert', async () => {
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      const { counters } = await runWith({
        cooldown,
        simulateResult: { status: 'revert', reason: 'amountOutMinimum not met' }
      })
      expect(counters.reverted).toBe(1)
      expect(cooldown.shouldSkip(LABEL)).toBe(true)
    })

    it('marks a bad-debt realization on a sim revert (cooldown check precedes the bad-debt branch)', async () => {
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      const { counters, quoteCalls } = await runWith({
        cooldown,
        out: lensOut({
          healthy: true,
          blockTimestamp: 3000n,
          debt: 1000n,
          badDebt: 1000n,
          market: { ...lensOut().market, maturity: 2000n }
        }),
        simulateResult: { status: 'revert', reason: 'boom' }
      })
      expect(quoteCalls()).toBe(0) // bad-debt realization never quotes
      expect(counters.reverted).toBe(1)
      expect(cooldown.shouldSkip(LABEL)).toBe(true)
    })

    it('does not mark the position on a successful submit', async () => {
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      const { counters } = await runWith({ cooldown, simulateResult: { status: 'ok' } })
      expect(counters.submitted).toBe(1)
      expect(cooldown.shouldSkip(LABEL)).toBe(false)
    })

    it('is disabled at 0: a failed attempt never skips or marks', async () => {
      const cooldown = createCooldownStore({ cooldownMs: 0 })
      const { counters } = await runWith({
        cooldown,
        quoteOutcome: { kind: 'failed', reason: 'no_route' }
      })
      expect(counters.cooledDown).toBe(0)
      expect(cooldown.shouldSkip(LABEL)).toBe(false)
    })
  })
  describe('submit outcome', () => {
    it('keeps the failure history but records nothing when the QUEUE refused', async () => {
      // Seeded at block 1 (suppressed until 3) so it does not suppress this tick at 100. A queue-wide
      // refusal says nothing about this position, so its history must survive un-extended: clearing
      // it is what let a failing position reset to attempt 1 and re-quote every other block.
      const { counters, backoff, submitCalls } = await runWith({
        seedBackoffAt: 1n,
        submitOutcome: { sent: false, reason: 'refused' }
      })
      expect(submitCalls()).toBe(1)
      expect(counters).toMatchObject({ ok: 1, submitted: 0, notSent: 1 })
      expect(backoff.shouldSkip(LABEL, 1n)).toBe(true)
      // Not re-armed: the next block may try again, which is the point of not blaming the position.
      expect(backoff.shouldSkip(LABEL, 101n)).toBe(false)
      expectCounterIdentities(counters)
    })

    it("re-arms backoff when THIS position's send was rejected", async () => {
      // The send itself failed, which is a fact about this position. Reaching submit at all means any
      // earlier entry had expired, so leaving it untouched would suppress nothing and the next block
      // would re-quote, re-simulate and re-send — the exact loop backoff exists to stop.
      const { counters, backoff } = await runWith({
        seedBackoffAt: 1n,
        submitOutcome: { sent: false, reason: 'send_failed' }
      })
      expect(counters).toMatchObject({ ok: 1, submitted: 0, notSent: 1 })
      expect(backoff.shouldSkip(LABEL, 101n)).toBe(true)
      expectCounterIdentities(counters)
    })

    it('clears backoff and counts submitted only when the queue broadcast', async () => {
      const { counters, backoff } = await runWith({
        seedBackoffAt: 1n,
        submitOutcome: { sent: true }
      })
      expect(counters).toMatchObject({ ok: 1, submitted: 1, notSent: 0 })
      expect(backoff.shouldSkip(LABEL, 1n)).toBe(false)
    })

    it('emits tick.end with complete: false when a submit aborts the tick', async () => {
      const { logger, events } = spyLogger()
      await expect(
        runTick({
          discover: async () => candidates(BORROWER),
          chainHead: 100n,
          caller: CALLER,
          seizeCapMarginBps: 0,
          headroomFloorBps: 0,
          minSurplusBps: 0,
          readLens: stubReadLens(lensOut()),
          quoteFor: async () => ({ kind: 'swap', plan: SWAP_PLAN }),
          simulate: async () => ({ status: 'ok' }),
          submit: async () => {
            // The real failure the queue documents for this path: a first send that claimed a nonce
            // but produced no hash. Using the exported type keeps the fixture honest if the tick ever
            // discriminates on it.
            throw new TxSendError('nonce claimed, no hash', 7)
          },
          backoff: createBackoff({ baseBlocks: 2n, maxBlocks: 64n }),
          cooldown: createCooldownStore({ cooldownMs: 0 }),
          inflightLabels: () => new Set(),
          usdValueOf: (_loanToken, loanUnits) => loanUnits,
          logger
        })
      ).rejects.toThrow('nonce claimed, no hash')
      const end = events.find(e => e.event === 'tick.end')
      expect(end?.fields).toMatchObject({ ok: 1, submitted: 0, notSent: 0, complete: false })
    })
  })

  describe('plan skips', () => {
    it('reports nothing_to_seize without recording backoff or cooldown', async () => {
      // An empty best slot would otherwise build a (0, 0) plan, which isBadDebtRealization reads as a
      // write-off against a still-solvent position.
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      const { counters, events, backoff, quoteCalls } = await runWith({
        cooldown,
        out: lensOut({ bestCollateralAmt: 0n })
      })
      expect(counters).toMatchObject({ liquidatable: 1, planSkipped: 1, planned: 0 })
      expect(quoteCalls()).toBe(0)
      const skipped = events.find(e => e.event === 'plan.skipped')
      expect(skipped?.level).toBe('info')
      expect(skipped?.fields).toMatchObject({ reason: 'nothing_to_seize' })
      // A sizing skip is not a failure — several reasons clear as chain time advances.
      expect(backoff.shouldSkip(LABEL, 100n)).toBe(false)
      expect(cooldown.shouldSkip(LABEL)).toBe(false)
      expectCounterIdentities(counters)
    })

    it('reports insufficient_headroom at debug, spending no quote and recording no backoff', async () => {
      // Past maturity and healthy, 20s into the LIF ramp: ~2bps of headroom against a 3bps floor. The
      // point of the gate is that this costs no aggregator call, no simulation and no gas estimate.
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      const { counters, events, backoff, quoteCalls, simulateCalls } = await runWith({
        cooldown,
        headroomFloorBps: 3,
        out: lensOut({ healthy: true, blockTimestamp: 2020n, bestCollateralMaxLif: MAX_LIF })
      })
      expect(counters).toMatchObject({ liquidatable: 1, planSkipped: 1, planned: 0 })
      expect(quoteCalls()).toBe(0)
      expect(simulateCalls()).toBe(0)
      const skipped = events.find(e => e.event === 'plan.skipped')
      // debug, not info: headroom is a group property, so this fires identically for every candidate
      // in the group — one line per position per block is the shape that buried the 31 Jul post-mortem.
      expect(skipped?.level).toBe('debug')
      expect(skipped?.fields).toMatchObject({
        reason: 'insufficient_headroom',
        // The realized headroom AND the LIF/mode it came from: `maxLif` plus chain time do not
        // identify them, because a matured-and-unhealthy position may be sized in either mode.
        headroomFloorBps: 3,
        postMaturityMode: true,
        secondsSinceMaturity: 20n
      })
      // ~2bps at 20s into a 3600s ramp on a 3.63% incentive — under the 3bps floor that rejected it.
      expect(skipped?.fields?.headroomBps as bigint).toBeLessThan(3n)
      expect(skipped?.fields?.lif as bigint).toBeGreaterThan(WAD_ONE)
      expect(skipped?.fields?.lif as bigint).toBeLessThan(MAX_LIF)
      expect(backoff.shouldSkip(LABEL, 100n)).toBe(false)
      expect(cooldown.shouldSkip(LABEL)).toBe(false)
      expectCounterIdentities(counters)
    })

    it('does not gate a matured-and-unhealthy position that normal mode funds at maxLif', async () => {
      // Regression companion to the sizing test: same instant as above but UNHEALTHY, so both on-chain
      // gates are open and normal mode wins with the full maxLif. It must be worked, not skipped.
      const { counters, quoteCalls } = await runWith({
        headroomFloorBps: 100,
        out: lensOut({ healthy: false, blockTimestamp: 2020n, bestCollateralMaxLif: MAX_LIF })
      })
      expect(counters).toMatchObject({ liquidatable: 1, planSkipped: 0, planned: 1 })
      expect(quoteCalls()).toBe(1)
      expectCounterIdentities(counters)
    })

    it('reports writeoff_below_max_debt when the write-off pushes effective debt under maxDebt', async () => {
      // debt 1000 - badDebt 200 = 800 effective, under maxDebt 900, while debt > maxDebt keeps normal
      // mode open. maxRepaidNormalMode's numerator goes negative, and a negative cap used to propagate
      // into a negative seizedAssets rather than a skip.
      const { counters, events } = await runWith({
        out: lensOut({ badDebt: 200n, market: { ...lensOut().market, rcfThreshold: 1n } })
      })
      expect(counters).toMatchObject({ liquidatable: 1, planSkipped: 1, planned: 0 })
      const skipped = events.find(e => e.event === 'plan.skipped')
      expect(skipped?.fields).toMatchObject({ reason: 'writeoff_below_max_debt' })
      expectCounterIdentities(counters)
    })

    it('skips the same write-off case when the slot is RCF-EXEMPT', async () => {
      // Same numbers, but a large rcfThreshold makes the slot exempt, so the repay cap becomes the
      // still-positive effectiveDebt and the `cap_not_positive` guard never fires. The contract does
      // not save us: it evaluates `_position.debt - maxDebt` on the post-writeoff debt BEFORE the
      // exemption inside the same `require` (midnight-contracts.txt:1864), so the plan would revert
      // with Panic 0x11 every time. Guarding on the cap alone emitted it.
      const { counters, events } = await runWith({
        out: lensOut({
          badDebt: 200n,
          market: { ...lensOut().market, rcfThreshold: 10n ** 30n }
        })
      })
      expect(counters).toMatchObject({ liquidatable: 1, planSkipped: 1, planned: 0 })
      const skipped = events.find(e => e.event === 'plan.skipped')
      expect(skipped?.fields).toMatchObject({ reason: 'writeoff_below_max_debt' })
      expectCounterIdentities(counters)
    })
  })

  describe('profitability gate', () => {
    // The default fixture sizes a cap-bound normal-mode plan: seize 1100 at LIF 1.1, so the contract
    // ceil-derives a 1000-unit repay. That is the swap's break-even, and SWAP_PLAN clears it at 2000.
    const REQUIRED_REPAY = 1000n
    const quoting = (expectedAmountOut: bigint): QuoteOutcome => ({
      kind: 'swap',
      plan: { ...SWAP_PLAN, expectedAmountOut }
    })

    it('skips before simulating when the route cannot cover the derived repay', async () => {
      const { counters, simulateCalls, submitCalls, events } = await runWith({
        quoteOutcome: quoting(REQUIRED_REPAY - 1n)
      })
      expect(counters).toMatchObject({ planned: 1, quoteUnprofitable: 1, ok: 0, reverted: 0 })
      // The whole point: the shortfall is reported instead of being discovered as an allowance revert.
      expect(simulateCalls()).toBe(0)
      expect(submitCalls()).toBe(0)
      const skipped = events.find(e => e.event === 'quote.unprofitable')
      expect(skipped?.fields).toMatchObject({
        requiredRepay: REQUIRED_REPAY,
        achievableOut: REQUIRED_REPAY - 1n,
        shortfallBps: 10n
      })
      expectCounterIdentities(counters)
    })

    it('does not back off or cool down an unprofitable quote', async () => {
      const { counters, backoff, cooldown } = await runWith({
        quoteOutcome: quoting(REQUIRED_REPAY - 1n),
        cooldown: createCooldownStore({ cooldownMs: 60_000 })
      })
      // Asserted so the suppression checks below cannot pass by the gate simply never firing.
      expect(counters.quoteUnprofitable).toBe(1)
      // Economic non-viability is not a failure: break-even falls as the LIF ramps and route cost is
      // itself volatile, so suppressing the position would delay re-checking it precisely as it
      // becomes fundable.
      expect(backoff.shouldSkip(LABEL, 100n)).toBe(false)
      expect(cooldown.shouldSkip(LABEL)).toBe(false)
    })

    it('passes a route at exact break-even, and fails it once a surplus is required', async () => {
      const exact = await runWith({ quoteOutcome: quoting(REQUIRED_REPAY) })
      expect(exact.counters).toMatchObject({ quoteUnprofitable: 0, ok: 1, submitted: 1 })

      const withSurplus = await runWith({
        quoteOutcome: quoting(REQUIRED_REPAY),
        minSurplusBps: 1
      })
      expect(withSurplus.counters).toMatchObject({ quoteUnprofitable: 1, ok: 0 })
      expect(withSurplus.simulateCalls()).toBe(0)
    })

    it('reports the threshold it applied, so a rejection above break-even is diagnosable', async () => {
      // With a surplus required, a route can clear `requiredRepay` and still be rejected. Measuring the
      // shortfall against break-even would then report a NEGATIVE shortfall on a rejection, which tells
      // an operator nothing; it is measured against the threshold that actually fired.
      const { events, counters } = await runWith({
        quoteOutcome: quoting(REQUIRED_REPAY),
        minSurplusBps: 100
      })
      expect(counters).toMatchObject({ quoteUnprofitable: 1, ok: 0 })
      const skipped = events.find(e => e.event === 'quote.unprofitable')
      expect(skipped?.fields).toMatchObject({
        requiredRepay: REQUIRED_REPAY,
        achievableOut: REQUIRED_REPAY,
        minSurplusBps: 100
      })
      // The bar that fired is above break-even, and the shortfall is positive against it.
      expect(skipped?.fields?.requiredThreshold as bigint).toBeGreaterThan(REQUIRED_REPAY)
      expect(skipped?.fields?.shortfallBps as bigint).toBeGreaterThan(0n)
    })

    it('uses the LIF the plan was sized at, not the one chain time implies', async () => {
      // Matured AND unhealthy opens both on-chain gates, and sizing picks by surplus: one second past
      // maturity the post-maturity ramp is still ~WAD, so normal mode wins with the full maxLif and a
      // 1000-unit break-even. Deriving the LIF here from `blockTimestamp > maturity` instead would use
      // the ramping value, put break-even at 1100, and reject a route the chain funds.
      const { counters, simulateCalls } = await runWith({
        out: lensOut({ blockTimestamp: 2001n, healthy: false }),
        quoteOutcome: quoting(1050n)
      })
      expect(counters).toMatchObject({ planned: 1, quoteUnprofitable: 0, ok: 1, submitted: 1 })
      expect(simulateCalls()).toBe(1)
      expectCounterIdentities(counters)
    })
  })

  describe('counter identities', () => {
    it('holds across a mixed batch with an in-flight position', async () => {
      const second = getAddress('0x6666666666666666666666666666666666666666')
      const third = getAddress('0x7777777777777777777777777777777777777777')
      const { counters } = await runWith({
        borrowers: [BORROWER, second, third],
        inflight: new Set([LABEL])
      })
      expect(counters).toMatchObject({
        pairs: 3,
        liquidatable: 3,
        inflightSkipped: 1,
        planned: 2,
        ok: 2,
        submitted: 2
      })
      expectCounterIdentities(counters)
    })
  })
  describe('profit ordering', () => {
    // The repay cap binds at `debt - badDebt`, so debt sets the seize and therefore the surplus:
    // seize = cap * lif / WAD, surplus = seizedValue - ceil(seize * WAD / lif) = cap * (lif - 1)/WAD.
    // debt 500 -> 50, debt 1000 -> 100, debt 2000 -> 200, at maxLif 1.1.
    const SMALL = getAddress('0x0000000000000000000000000000000000000a11')
    const LARGE = getAddress('0x0000000000000000000000000000000000000b22')
    const MEDIUM = getAddress('0x0000000000000000000000000000000000000c33')

    it('works the highest-USD-surplus position first, whatever order discovery returned', async () => {
      const outs = new Map<Address, LensOut>([
        [SMALL, lensOut({ debt: 500n, maxDebt: 450n })],
        [LARGE, lensOut({ debt: 2000n, maxDebt: 1800n })],
        [MEDIUM, lensOut({ debt: 1000n, maxDebt: 900n })]
      ])
      const { counters, order } = await runWith({
        borrowers: [SMALL, LARGE, MEDIUM],
        outsByBorrower: outs
      })
      expect(counters).toMatchObject({ liquidatable: 3, planned: 3, unpriced: 0, submitted: 3 })
      expect(order).toEqual([LARGE, MEDIUM, SMALL])
      expectCounterIdentities(counters)
    })

    it('orders an unpriced candidate last even when its surplus is the largest', async () => {
      const UNPRICED_TOKEN = getAddress('0x9999999999999999999999999999999999999999')
      const outs = new Map<Address, LensOut>([
        // The bigger position is the unpriced one, so discovery order and surplus order both put it
        // first; only the unpriced-last rule can move it.
        [
          LARGE,
          lensOut({
            debt: 2000n,
            maxDebt: 1800n,
            market: { ...lensOut().market, loanToken: UNPRICED_TOKEN }
          })
        ],
        [MEDIUM, lensOut({ debt: 1000n, maxDebt: 900n })]
      ])
      const { counters, order } = await runWith({
        borrowers: [LARGE, MEDIUM],
        outsByBorrower: outs,
        usdValueOf: (loanToken, loanUnits) => (loanToken === UNPRICED_TOKEN ? null : loanUnits)
      })
      expect(counters).toMatchObject({ liquidatable: 2, planned: 2, unpriced: 1 })
      expect(order).toEqual([MEDIUM, LARGE])
      expectCounterIdentities(counters)
    })

    it('falls back to discovery order when nothing is priced', async () => {
      const outs = new Map<Address, LensOut>([
        [SMALL, lensOut({ debt: 500n, maxDebt: 450n })],
        [LARGE, lensOut({ debt: 2000n, maxDebt: 1800n })],
        [MEDIUM, lensOut({ debt: 1000n, maxDebt: 900n })]
      ])
      const { counters, order } = await runWith({
        borrowers: [SMALL, LARGE, MEDIUM],
        outsByBorrower: outs,
        usdValueOf: () => null
      })
      expect(counters.unpriced).toBe(3)
      expect(order).toEqual([SMALL, LARGE, MEDIUM])
    })

    it('logs rank and surplus on plan.built in the order worked', async () => {
      const outs = new Map<Address, LensOut>([
        [SMALL, lensOut({ debt: 500n, maxDebt: 450n })],
        [LARGE, lensOut({ debt: 2000n, maxDebt: 1800n })]
      ])
      const { events } = await runWith({ borrowers: [SMALL, LARGE], outsByBorrower: outs })
      const built = events.filter(e => e.event === 'plan.built')
      expect(built.map(e => e.fields?.rank)).toEqual([1, 2])
      expect(built.map(e => e.fields?.borrower)).toEqual([LARGE, SMALL])
      expect(built.map(e => e.fields?.surplus)).toEqual([200n, 50n])
      // Rendered at the USD scale rather than as a raw 1e8-scaled bigint.
      expect(built[0]?.fields?.surplusUsd).toBe('0.000002')
    })
  })
})
