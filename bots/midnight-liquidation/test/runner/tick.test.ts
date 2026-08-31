import type { Logger, SimulateResult, SubmitOutcome } from '@repo/bot-kit'
import type { CooldownStore } from '@repo/bot-kit'
import type { QuoteOutcome, SwapPlan, VenuePair } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { createBackoff, createCooldownStore, TxSendError } from '@repo/bot-kit'
import { lensKey } from '@repo/utils'
import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { BorrowerCandidate } from '../../src/discovery/borrowers'
import type { LiquidationPlan } from '../../src/sizing/plan'
import type { LensCollateral, LensInput, LensOut } from '../../src/state/lens.sol'

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
  // Per POSITION, up to and including sizing.
  expect(c.liquidatable).toBe(c.inflightSkipped! + c.planSkipped! + c.planned!)
  // Per CANDIDATE from there on: one position can yield several (slot, mode) alternatives, so this
  // sum heads on `candidates`, not `planned` — and `candidates >= planned` always.
  expect(c.candidates).toBeGreaterThanOrEqual(c.planned!)
  expect(c.candidates).toBe(
    c.cooledDown! +
      c.backoffSkipped! +
      c.siblingSkipped! +
      c.preselectSkipped! +
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
// Sorts after TOKEN, so `collateralParams` stays ascending as the protocol requires.
const COLLATERAL: Address = getAddress('0x7777777777777777777777777777777777777777')
const ORACLE: Address = getAddress('0x4444444444444444444444444444444444444444')
const ROUTER: Address = getAddress('0x5555555555555555555555555555555555555555')
const ZERO = '0x0000000000000000000000000000000000000000' as const
const MARKET: Hex = `0x${'a'.repeat(64)}`
const LABEL = lensKey(MARKET, BORROWER)
// Extra collateral tokens for multi-slot fixtures. All sort after TOKEN and among themselves, so
// `collateralParams` stays ascending as the protocol requires.
const collateralAt = (nibble: string): Address => getAddress(`0x${nibble.repeat(40)}`)
// 3.63% incentive → a 349bps headroom ceiling; the ramp reaches 3bps about 30s past maturity.
const WAD_ONE = 10n ** 18n
const MAX_LIF = 1036269430051813471n
// lltv 98% / cursor 0.30 — the loan-as-collateral slot's maxLif (60 bps of headroom at full ramp).
const LOAN_MAX_LIF = 1006036217303822937n

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
// One activated collateral slot. The default addresses `collateralParams[1]` (COLLATERAL), so it needs
// a swap; `index: 0` addresses the market's loan token and is therefore swap-free.
function slot(overrides: Partial<LensCollateral> = {}): LensCollateral {
  return {
    index: 1,
    amt: 5000n,
    price: 10n ** 36n,
    maxLif: 1100000000000000000n,
    lltv: 860000000000000000n,
    ...overrides
  }
}

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
    collaterals: [slot()],
    market: {
      chainId: 8453n,
      midnight: ZERO,
      loanToken: TOKEN,
      // Two slots, mirroring a live loan-as-collateral market: [0] is the loan token itself at 98%
      // lltv, [1] is a real collateral at 86%. Ascending by address, as the protocol requires.
      collateralParams: [
        {
          token: TOKEN,
          lltv: 980000000000000000n,
          liquidationCursor: 300000000000000000n,
          oracle: ORACLE
        },
        {
          token: COLLATERAL,
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
  /**
   * Per-call quote outcomes, consumed in order — for candidate fall-through, where the point is that
   * the SECOND call behaves differently from the first. The last entry repeats once exhausted.
   */
  quoteOutcomes?: QuoteOutcome[]
  /** Per-call simulate results, same sequencing as `quoteOutcomes`. */
  simulateResults?: SimulateResult[]
  /**
   * What the fake probe curve reports, in bps of the oracle reference, keyed by the collateral token
   * being sold — the axis a real pair differs by. A token ABSENT from the map reads as a cold pair
   * (`routeCost` → `[]`), which is what the fail-open path keys on; an empty/omitted map is therefore
   * a fully cold curve, i.e. exactly the pre-curve behaviour.
   */
  routeCostBps?: Map<Address, number>
  /** Models an estimate taken from a ladder end: present in the curve, but not trustworthy. */
  clampedRoutes?: boolean
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
  // Collateral tokens phase A.5 asked to be warmed, in call order — one entry per refresh actually
  // issued, so a duplicate here is a duplicated probe burst.
  const warmed: Address[] = []
  const routing = {
    resolveRoute: async (plan: LiquidationPlan, out: LensOut) => {
      const collateral = out.market.collateralParams[plan.collateralIndex]
      if (!collateral || collateral.token === out.market.loanToken) return null
      return {
        pair: { collateral: collateral.token, loan: out.market.loanToken },
        amountIn: plan.seizedAssets
      }
    },
    warmRoute: async (pair: VenuePair) => {
      warmed.push(pair.collateral)
    },
    routeCost: (pair: VenuePair, _amountIn: bigint, referenceAmountOut: bigint) => {
      const bps = opts.routeCostBps?.get(pair.collateral)
      if (bps === undefined) return []
      const cost = (referenceAmountOut * BigInt(bps)) / 10_000n
      return [
        {
          venue: '0x' as const,
          estimatedOut: referenceAmountOut - cost,
          costBps: bps,
          costBpsRaw: bps,
          clamped: opts.clampedRoutes ?? false,
          ageMs: 0
        }
      ]
    }
  }
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
      const sequenced =
        opts.quoteOutcomes?.[Math.min(quoteCalls - 1, opts.quoteOutcomes.length - 1)]
      return sequenced ?? opts.quoteOutcome ?? defaultOutcome
    },
    simulate: async () => {
      simulateCalls += 1
      const sequenced =
        opts.simulateResults?.[Math.min(simulateCalls - 1, opts.simulateResults.length - 1)]
      return sequenced ?? opts.simulateResult ?? { status: 'ok' }
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
    routing,
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
    warmed,
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
      candidates: 1,
      cooledDown: 0,
      backoffSkipped: 0,
      siblingSkipped: 0,
      preselectSkipped: 0,
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
        submitOutcome: { sent: false, reason: 'send_failed', executionRevert: false }
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
          // A fully cold curve, so this case exercises the fail-open ordering it always did.
          routing: {
            resolveRoute: async () => null,
            warmRoute: async () => {},
            routeCost: () => []
          },
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
        out: lensOut({ collaterals: [slot({ amt: 0n })] })
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
        out: lensOut({
          healthy: true,
          blockTimestamp: 2020n,
          collaterals: [slot({ maxLif: MAX_LIF })]
        })
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
        out: lensOut({
          healthy: false,
          blockTimestamp: 2020n,
          collaterals: [slot({ maxLif: MAX_LIF })]
        })
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

  describe('multi-collateral candidate fall-through', () => {
    // A two-slot position: `collateralParams[1]` (COLLATERAL, 86% lltv) needs a swap and outranks
    // `collateralParams[0]` (the loan token itself, 98% lltv) on surplus, so it is tried first.
    const twoSlots = () =>
      lensOut({
        activatedBitmap: 0b11n,
        collaterals: [slot({ index: 1 }), slot({ index: 0, maxLif: LOAN_MAX_LIF })]
      })

    it('counts one planned POSITION but two CANDIDATES', async () => {
      // The two `tick.end` identities count different things; this is the case that separates them.
      const { counters } = await runWith({ out: twoSlots() })
      expect(counters).toMatchObject({ liquidatable: 1, planned: 1, candidates: 2 })
      expectCounterIdentities(counters)
    })

    it('falls through to the swap-free slot IN THE SAME TICK when the first slot fails to quote', async () => {
      // The regression this whole restructuring exists for. `backoff.record(label, chainHead)` sets
      // `until = chainHead + baseBlocks` and `shouldSkip(label, chainHead)` tests `chainHead < until`,
      // so recording the first candidate's failure inline would suppress its own sibling and the
      // position would go unliquidated for a block — with the certain slot sitting right there.
      const { counters, submitCalls, quoteCalls } = await runWith({
        out: twoSlots(),
        quoteOutcomes: [
          { kind: 'failed', reason: 'no_route' },
          { kind: 'swap', plan: SWAP_PLAN }
        ]
      })
      expect(quoteCalls()).toBe(2)
      expect(submitCalls()).toBe(1)
      expect(counters).toMatchObject({ candidates: 2, quoteFailed: 1, ok: 1, submitted: 1 })
      expectCounterIdentities(counters)
    })

    it('records backoff and cooldown ONCE for the position, after every candidate has had its turn', async () => {
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      const { counters, backoff, quoteCalls } = await runWith({
        cooldown,
        out: twoSlots(),
        quoteOutcome: { kind: 'failed', reason: 'no_route' }
      })
      // Both candidates were tried despite the first one failing.
      expect(quoteCalls()).toBe(2)
      expect(counters).toMatchObject({ candidates: 2, quoteFailed: 2 })
      // One position, so one backoff entry at attempt 1 — not two attempts' worth of exponent.
      expect(backoff.shouldSkip(LABEL, 101n)).toBe(true)
      expect(backoff.shouldSkip(LABEL, 102n)).toBe(false)
      expect(cooldown.shouldSkip(LABEL)).toBe(true)
      expectCounterIdentities(counters)
    })

    it('skips the remaining candidates once one has broadcast', async () => {
      const { counters, submitCalls } = await runWith({ out: twoSlots() })
      // One liquidation per position per tick: the sibling is an alternative, not extra work.
      expect(submitCalls()).toBe(1)
      expect(counters).toMatchObject({ candidates: 2, submitted: 1, siblingSkipped: 1 })
      expectCounterIdentities(counters)
    })

    it('clears backoff on a successful sibling rather than leaving the earlier failure recorded', async () => {
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      const { backoff } = await runWith({
        cooldown,
        out: twoSlots(),
        quoteOutcomes: [
          { kind: 'failed', reason: 'no_route' },
          { kind: 'swap', plan: SWAP_PLAN }
        ]
      })
      // The position was liquidated, so the failed sibling must not suppress the next block.
      expect(backoff.shouldSkip(LABEL, 101n)).toBe(false)
      expect(cooldown.shouldSkip(LABEL)).toBe(false)
    })

    it('records NO backoff when every candidate is an economic refusal', async () => {
      // `floor_unmet` and an unprofitable quote say nothing about the next attempt — both sides of the
      // comparison move on a ten-second scale — so neither suppresses the position.
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      const { counters, backoff } = await runWith({
        cooldown,
        out: twoSlots(),
        quoteOutcome: { kind: 'failed', reason: 'floor_unmet' }
      })
      expect(counters).toMatchObject({ candidates: 2, quoteUnprofitable: 2 })
      expect(backoff.shouldSkip(LABEL, 101n)).toBe(false)
      expect(cooldown.shouldSkip(LABEL)).toBe(false)
      expectCounterIdentities(counters)
    })

    it('marks cooldown but NOT backoff when every candidate lacks a swap path', async () => {
      // Preserves the documented `no_config` contract: a coverage gap, not a failure.
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      const { counters, backoff } = await runWith({
        cooldown,
        out: twoSlots(),
        noSwap: true
      })
      expect(counters).toMatchObject({ candidates: 2, noSwapPath: 2 })
      expect(backoff.shouldSkip(LABEL, 101n)).toBe(false)
      expect(cooldown.shouldSkip(LABEL)).toBe(true)
      expectCounterIdentities(counters)
    })

    it('falls through to the other MODE when the first mode simulates reverted', async () => {
      // Matured AND unhealthy on one slot, so the contract opens both gates. Normal mode ranks first
      // (full maxLif vs a ramping post-maturity LIF) but its gate `debt > maxDebt` can close between
      // the lens read and the broadcast — if the price recovered, it reverts. Post-maturity's gate
      // cannot close, so it must still be available to submit in the SAME tick.
      const bothModes = lensOut({ blockTimestamp: 2060n, healthy: false })
      const { counters, submitCalls, events } = await runWith({
        out: bothModes,
        simulateResults: [{ status: 'revert', reason: 'NotLiquidatable' }, { status: 'ok' }]
      })
      expect(counters).toMatchObject({ planned: 1, candidates: 2, reverted: 1, submitted: 1 })
      expect(submitCalls()).toBe(1)
      const sims = events.filter(e => e.event.startsWith('simulate.'))
      expect(sims.map(e => e.fields?.postMaturityMode)).toEqual([false, true])
      expectCounterIdentities(counters)
    })

    it('attributes every plan.skipped line to its slot', async () => {
      const { events } = await runWith({
        out: lensOut({ collaterals: [slot({ index: 1, amt: 0n }), slot({ index: 0, amt: 0n })] })
      })
      const skipped = events.filter(e => e.event === 'plan.skipped')
      expect(skipped.map(e => e.fields?.collateralIndex)).toEqual([1, 0])
    })

    it('identifies which candidate each simulate line belongs to', async () => {
      // Two attempts on one position share a (marketId, borrower), so without collateralIndex the log
      // join cannot separate them.
      const { events } = await runWith({
        out: twoSlots(),
        simulateResults: [{ status: 'revert', reason: 'stale quote' }, { status: 'ok' }]
      })
      const sims = events.filter(e => e.event.startsWith('simulate.'))
      expect(sims).toHaveLength(2)
      expect(sims.map(e => e.fields?.collateralIndex)).toEqual([1, 0])
    })
  })

  describe('net-of-route-cost ordering', () => {
    // Extra collateral tokens, in `collateralParams` order: slot index i+1 sells `SWAP_TOKENS[i]`.
    const SWAP_TOKENS = ['8', '9', 'a', 'b', 'c'].map(collateralAt)
    // Against this fixture's debt (1000, maxDebt 900, cap-bound) a slot's gross surplus is exactly
    // `1000 * (maxLif - 1)`, and its oracle reference is `1000 * maxLif` — so maxLif 1.10 is a surplus
    // of 100 on a reference of 1100, and the loan-token slot's 1.006036 maxLif is a surplus of 6.
    const lifFor = (surplus: number) => WAD_ONE + BigInt(surplus) * 10n ** 15n

    /**
     * A position with one activated slot per requested gross surplus, each selling its own collateral
     * token, optionally plus the market's own loan-token slot at index 0 — the swap-free alternative,
     * whose surplus is always 6.
     */
    const multiSlot = (args: { surpluses: number[]; withLoanSlot?: boolean }): LensOut => {
      const base = lensOut()
      const swapSlots = args.surpluses.map((surplus, i) =>
        slot({ index: i + 1, maxLif: lifFor(surplus) })
      )
      return lensOut({
        collaterals: args.withLoanSlot
          ? [...swapSlots, slot({ index: 0, maxLif: LOAN_MAX_LIF })]
          : swapSlots,
        market: {
          ...base.market,
          collateralParams: [
            base.market.collateralParams[0]!,
            ...SWAP_TOKENS.slice(0, args.surpluses.length).map(token => ({
              token,
              lltv: 860000000000000000n,
              liquidationCursor: 250000000000000000n,
              oracle: ORACLE
            }))
          ]
        }
      })
    }

    const costs = (...bps: [Address, number][]) => new Map(bps)

    const builtIndexes = (events: { event: string; fields?: Record<string, unknown> }[]) =>
      events.filter(e => e.event === 'plan.built').map(e => e.fields?.collateralIndex)

    const preselectSkips = (events: { event: string; fields?: Record<string, unknown> }[]) =>
      events
        .filter(e => e.event === 'preselect.skipped')
        .map(e => [e.fields?.collateralIndex, e.fields?.reason])

    it('flips a pair of candidates that gross surplus would have ranked the other way', async () => {
      // Slot 1 is worth 100 gross but pays 300 bps of a 1100 reference (33); slot 2 is worth 80 and
      // pays nothing. 67 < 80, so the cheaper route wins — the ordering the oracle alone cannot see.
      const out = multiSlot({ surpluses: [100, 80] })
      const priced = await runWith({
        out,
        routeCostBps: costs([SWAP_TOKENS[0]!, 300], [SWAP_TOKENS[1]!, 0])
      })
      expect(builtIndexes(priced.events)).toEqual([2])
      expect(priced.events.find(e => e.event === 'plan.built')?.fields).toMatchObject({
        routeCostBps: 0,
        netUsd: '0.0000008'
      })

      const gross = await runWith({ out })
      expect(builtIndexes(gross.events)).toEqual([1])
    })

    it('prefers the swap-free candidate over a higher-gross one that pays route cost', async () => {
      // The measured shape: a loan-as-collateral slot pays zero, so a nominally larger swap slot loses
      // to it on a route cost of a few tens of bps. 8 gross - 30 bps of 1008 (3) = 5, against 6.
      const out = multiSlot({ surpluses: [8], withLoanSlot: true })
      const priced = await runWith({ out, routeCostBps: costs([SWAP_TOKENS[0]!, 30]) })
      expect(builtIndexes(priced.events)).toEqual([0])

      const gross = await runWith({ out })
      expect(builtIndexes(gross.events)).toEqual([1])
    })

    it('keeps the true net winner that gross ordering would have truncated away', async () => {
      // Five candidates, cap four. Gross order is 100/80/60/40/20 and drops the 20; net order puts the
      // 20 FIRST, because it is the only one whose route is free. Capping before re-ranking — what
      // sizing used to do — would have discarded the winner before it was ever compared.
      const out = multiSlot({ surpluses: [100, 80, 60, 40, 20] })
      const priced = SWAP_TOKENS.map((token, i) => [token, i < 4 ? 1000 : 0] as [Address, number])
      const { counters, events } = await runWith({ out, routeCostBps: costs(...priced) })
      expect(builtIndexes(events)).toEqual([5])
      expect(preselectSkips(events)).toEqual([[4, 'position_cap']])
      expect(counters).toMatchObject({ candidates: 5, preselectSkipped: 1, submitted: 1 })
      expectCounterIdentities(counters)

      const gross = await runWith({ out })
      expect(builtIndexes(gross.events)).toEqual([1])
      expect(preselectSkips(gross.events)).toEqual([[5, 'position_cap']])
    })

    it('never lets the cap discard the best swap-free candidate', async () => {
      // Four free-routing swap slots outrank the swap-free one on net as well as gross, so the cap
      // would drop it on the ordering alone — it is the only candidate guaranteed to be fundable.
      const out = multiSlot({ surpluses: [100, 80, 60, 40], withLoanSlot: true })
      const free = SWAP_TOKENS.slice(0, 4).map(token => [token, 0] as [Address, number])
      const { counters, events } = await runWith({
        out,
        routeCostBps: costs(...free),
        quoteOutcome: { kind: 'failed', reason: 'no_route' }
      })
      // The 40-gross slot is the one the cap gives up for it; index 0 is never a `position_cap` drop.
      expect(preselectSkips(events)).toContainEqual([4, 'position_cap'])
      expect(builtIndexes(events)).toContain(0)
      expectCounterIdentities(counters)
    })

    it('falls open to gross ordering, with no new cutoff, when the curve is cold', async () => {
      const out = multiSlot({ surpluses: [100, 80, 60] })
      const { counters, events, quoteCalls } = await runWith({
        out,
        quoteOutcome: { kind: 'failed', reason: 'no_route' }
      })
      expect(builtIndexes(events)).toEqual([1, 2, 3])
      expect(quoteCalls()).toBe(3)
      expect(counters).toMatchObject({ candidates: 3, preselectSkipped: 0, quoteFailed: 3 })
      expectCounterIdentities(counters)
    })

    it('falls open the same way when the best estimate is clamped', async () => {
      // A clamped estimate comes from a ladder end rather than from between two rungs, so it cannot be
      // trusted at this size. Priced, it would have ordered 2/3/1 and quoted only two of the three.
      const out = multiSlot({ surpluses: [100, 80, 60] })
      const map = costs([SWAP_TOKENS[0]!, 1000], [SWAP_TOKENS[1]!, 0], [SWAP_TOKENS[2]!, 0])
      const clamped = await runWith({
        out,
        routeCostBps: map,
        clampedRoutes: true,
        quoteOutcome: { kind: 'failed', reason: 'no_route' }
      })
      expect(builtIndexes(clamped.events)).toEqual([1, 2, 3])
      expect(clamped.counters).toMatchObject({ preselectSkipped: 0, quoteFailed: 3 })

      const trusted = await runWith({
        out,
        routeCostBps: map,
        quoteOutcome: { kind: 'failed', reason: 'no_route' }
      })
      expect(builtIndexes(trusted.events)).toEqual([2, 3])
      expect(trusted.counters).toMatchObject({ preselectSkipped: 1, quoteFailed: 2 })
    })

    it('leaves a position whose loan token is unpriced on gross ordering', async () => {
      // Both terms come from the same USD conversion, so an unpriced loan token makes the cost unknown
      // rather than zero — the position must not be scored as if its route were free.
      const out = multiSlot({ surpluses: [100, 80] })
      const { counters, events } = await runWith({
        out,
        routeCostBps: costs([SWAP_TOKENS[0]!, 300], [SWAP_TOKENS[1]!, 0]),
        usdValueOf: () => null,
        quoteOutcome: { kind: 'failed', reason: 'no_route' }
      })
      expect(builtIndexes(events)).toEqual([1, 2])
      expect(counters).toMatchObject({ unpriced: 2, preselectSkipped: 0 })
    })
  })

  describe('bounded preselection', () => {
    const SWAP_TOKENS = ['8', '9', 'a', 'b', 'c'].map(collateralAt)
    const lifFor = (surplus: number) => WAD_ONE + BigInt(surplus) * 10n ** 15n

    // Three swap slots plus the loan-token slot, all routing free, so the ordering is the gross one and
    // the bound is what decides how many quotes the position spends.
    const fourCandidates = (): LensOut => {
      const base = lensOut()
      return lensOut({
        collaterals: [
          ...[100, 80, 60].map((surplus, i) => slot({ index: i + 1, maxLif: lifFor(surplus) })),
          slot({ index: 0, maxLif: LOAN_MAX_LIF })
        ],
        market: {
          ...base.market,
          collateralParams: [
            base.market.collateralParams[0]!,
            ...SWAP_TOKENS.slice(0, 3).map(token => ({
              token,
              lltv: 860000000000000000n,
              liquidationCursor: 250000000000000000n,
              oracle: ORACLE
            }))
          ]
        }
      })
    }
    const freeRoutes = new Map(SWAP_TOKENS.slice(0, 3).map(token => [token, 0]))

    it('quotes the top-ranked candidate plus a bounded fall-through, reserving the swap-free one', async () => {
      const { counters, events, quoteCalls } = await runWith({
        out: fourCandidates(),
        routeCostBps: freeRoutes,
        quoteOutcome: { kind: 'failed', reason: 'no_route' }
      })
      // Two attempts, then the third swap slot is dropped — but the swap-free candidate is exempt from
      // the bound however late it ranks, so it still gets its turn in the same tick.
      expect(quoteCalls()).toBe(3)
      expect(
        events.filter(e => e.event === 'plan.built').map(e => e.fields?.collateralIndex)
      ).toEqual([1, 2, 0])
      expect(
        events
          .filter(e => e.event === 'preselect.skipped')
          .map(e => [e.fields?.collateralIndex, e.fields?.reason])
      ).toEqual([[3, 'fall_through_bound']])
      expect(counters).toMatchObject({ candidates: 4, quoteFailed: 3, preselectSkipped: 1 })
      expectCounterIdentities(counters)
    })

    it('spends no fall-through on a position that already broadcast', async () => {
      const { counters } = await runWith({ out: fourCandidates(), routeCostBps: freeRoutes })
      expect(counters).toMatchObject({
        candidates: 4,
        submitted: 1,
        siblingSkipped: 3,
        preselectSkipped: 0
      })
      expectCounterIdentities(counters)
    })

    it('does not consume the bound with candidates excluded BEFORE the suppression checks', async () => {
      // A cooldown skip spends no venue call, so it must not consume a budget that exists to cap venue
      // calls — every candidate reports the one verdict that applies, rather than two of them reporting
      // `cooledDown` and the rest `preselectSkipped`.
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      cooldown.mark(LABEL)
      const { counters } = await runWith({
        out: fourCandidates(),
        routeCostBps: freeRoutes,
        cooldown
      })
      expect(counters).toMatchObject({ candidates: 4, cooledDown: 4, preselectSkipped: 0 })
      expectCounterIdentities(counters)
    })

    it('does not consume the bound with candidates excluded AFTER the cooldown check either', async () => {
      const { counters } = await runWith({
        out: fourCandidates(),
        routeCostBps: freeRoutes,
        seedBackoffAt: 100n
      })
      expect(counters).toMatchObject({ candidates: 4, backoffSkipped: 4, preselectSkipped: 0 })
      expectCounterIdentities(counters)
    })
  })

  describe('phase A.5 probe warming', () => {
    it('warms a pair once for several candidates that share it', async () => {
      const second = getAddress('0x6666666666666666666666666666666666666666')
      const { warmed } = await runWith({ borrowers: [BORROWER, second] })
      expect(warmed).toEqual([COLLATERAL])
    })

    it('warms nothing for a candidate that needs no route', async () => {
      // The swap-free slot resolves to no pair at all, so it never costs a probe burst.
      const { warmed } = await runWith({
        out: lensOut({
          activatedBitmap: 0b11n,
          collaterals: [slot({ index: 1 }), slot({ index: 0, maxLif: LOAN_MAX_LIF })]
        })
      })
      expect(warmed).toEqual([COLLATERAL])
    })

    it('warms no pair for a position sizing never reached', async () => {
      // A cold refresh is one venue call per ladder rung per venue, so warming has to be scoped to the
      // pairs that actually have a sized candidate — an in-flight position has none.
      const { warmed } = await runWith({ inflight: new Set([LABEL]) })
      expect(warmed).toEqual([])
    })

    it('resolves and warms nothing for a bad-debt write-off', async () => {
      // A write-off trades nothing and phase B never quotes it, so resolving its unwrap chain and
      // sweeping its pair would be venue and chain work spent on a route no one will ever sell through.
      const { counters, warmed, quoteCalls } = await runWith({
        out: lensOut({
          healthy: true,
          blockTimestamp: 3000n,
          debt: 1000n,
          badDebt: 1000n,
          market: { ...lensOut().market, maturity: 2000n }
        })
      })
      expect(quoteCalls()).toBe(0)
      expect(warmed).toEqual([])
      // Costed as zero, not unknown: `unknown` fails the whole POSITION open to gross ordering.
      expect(counters).toMatchObject({ submitted: 1, preselectSkipped: 0 })
      expectCounterIdentities(counters)
    })

    it('resolves no route past the gross probe bound', async () => {
      // Each distinct pair costs a full indicative sweep, so the candidates whose route is resolved at
      // all are bounded on the gross ordering — the one cap that must be applied before any cost is
      // known. Nine candidates, eight probed, and the swap-free one is still reserved a place.
      const nibbles = ['8', '9', 'a', 'b', 'c', 'd', 'e', 'f']
      const base = lensOut()
      const out = lensOut({
        collaterals: [
          ...[100, 90, 80, 70, 60, 50, 40, 30].map((surplus, i) =>
            slot({ index: i + 1, maxLif: WAD_ONE + BigInt(surplus) * 10n ** 15n })
          ),
          slot({ index: 0, maxLif: LOAN_MAX_LIF })
        ],
        market: {
          ...base.market,
          collateralParams: [
            base.market.collateralParams[0]!,
            ...nibbles.map(nibble => ({
              token: collateralAt(nibble),
              lltv: 860000000000000000n,
              liquidationCursor: 250000000000000000n,
              oracle: ORACLE
            }))
          ]
        }
      })
      const { counters, warmed, events } = await runWith({
        out,
        quoteOutcome: { kind: 'failed', reason: 'no_route' }
      })

      // Seven swap pairs: the eighth slot in the bound is the reserved swap-free candidate, which needs
      // no pair at all, and the ninth-ranked swap slot is dropped before resolution.
      expect(warmed).toHaveLength(7)
      const skips = events
        .filter(e => e.event === 'preselect.skipped')
        .map(e => [e.fields?.collateralIndex, e.fields?.reason])
      expect(skips.filter(([, reason]) => reason === 'probe_cap')).toEqual([[8, 'probe_cap']])
      // The final net cap then keeps four of the eight probed ones, as it always did.
      expect(counters).toMatchObject({ candidates: 9, preselectSkipped: 5, quoteFailed: 4 })
      expectCounterIdentities(counters)
    })
  })

  describe('firm-call budget', () => {
    it('sums the firm calls a tick actually spent onto tick.end', async () => {
      const { events } = await runWith({
        out: lensOut({
          activatedBitmap: 0b11n,
          collaterals: [slot({ index: 1 }), slot({ index: 0, maxLif: LOAN_MAX_LIF })]
        }),
        quoteOutcomes: [
          { kind: 'failed', reason: 'no_route', firmCalls: 2 },
          { kind: 'swap', plan: SWAP_PLAN, firmCalls: 3 }
        ]
      })
      expect(events.find(e => e.event === 'tick.end')?.fields).toMatchObject({
        firmCalls: 5,
        firmCallsUnknown: 0
      })
    })

    it('reports an absent count as unknown rather than as zero', async () => {
      const { events } = await runWith({})
      const end = events.find(e => e.event === 'tick.end')
      expect(end?.fields?.firmCalls).toBeNull()
      expect(end?.fields).toMatchObject({ firmCallsUnknown: 1 })
      expect(typeof end?.fields?.durationMs).toBe('number')
    })
  })
})
