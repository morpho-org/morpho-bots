import type { Logger, SimulateResult, SubmitOutcome } from '@repo/bot-kit'
import type { Backoff, BlockSampler, CooldownStore } from '@repo/bot-kit'
import type { QuoteOutcome, SwapPlan } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { createBackoff, createBlockSampler, createCooldownStore } from '@repo/bot-kit'
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

const BORROWER: Address = getAddress('0x1111111111111111111111111111111111111111')
const CALLER: Address = getAddress('0x2222222222222222222222222222222222222222')
const TOKEN: Address = getAddress('0x3333333333333333333333333333333333333333')
const ORACLE: Address = getAddress('0x4444444444444444444444444444444444444444')
const ROUTER: Address = getAddress('0x5555555555555555555555555555555555555555')
const ZERO = '0x0000000000000000000000000000000000000000' as const
const MARKET: Hex = `0x${'a'.repeat(64)}`
const LABEL = lensKey(MARKET, BORROWER)
const TX_HASH: Hex = `0x${'b'.repeat(64)}`
const SENT: SubmitOutcome = { kind: 'sent', nonce: 7, txHash: TX_HASH }

type TickCounters = Awaited<ReturnType<typeof runTick>>

/**
 * Asserted for EVERY case built by `runWith`, so a stage added without a counter breaks a sum rather
 * than silently dropping a position — the exact class of bug these counters exist to catch.
 */
function expectCountersConsistent(c: TickCounters) {
  expect(c.pairs).toBeGreaterThanOrEqual(c.liquidatable)
  expect(c.liquidatable).toBe(c.inflightSkipped + c.planSkipped + c.planned)
  expect(c.planned).toBe(
    c.cooledDown + c.backoffSkipped + c.noSwapPath + c.quoteFailed + c.ok + c.reverted
  )
  expect(c.ok).toBe(c.submitted + c.notSent)
}

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

function stubReadLens(out: LensOut | null) {
  return async (pairs: LensInput[]) => {
    const map = new Map<string, LensOut>()
    if (out) for (const pair of pairs) map.set(lensKey(pair.id, pair.borrower), out)
    return map
  }
}

type RunOpts = {
  out?: LensOut | null
  simulateResult?: SimulateResult
  quoteOutcome?: QuoteOutcome
  borrowers?: Address[]
  discoverError?: Error
  chainHead?: bigint
  inflight?: ReadonlySet<string>
  noSwap?: boolean
  seedBackoffAt?: bigint
  cooldown?: CooldownStore
  seizeCapMarginBps?: number
  /** What the queue reports; defaults to a real broadcast. */
  submitOutcome?: SubmitOutcome
  /** Makes `submit` throw, as a hashless send after a nonce was claimed does. */
  submitThrows?: Error
  /** Reuse a store/sampler across two `runTick` calls, so cross-tick behavior can be asserted. */
  backoff?: Backoff
  planSkipSampler?: BlockSampler
}

// Shared dep construction so the throwing case exercises exactly the same wiring as `runWith`.
function buildDeps(opts: RunOpts) {
  const { logger, events } = spyLogger()
  let simulateCalls = 0
  let submitCalls = 0
  let quoteCalls = 0
  const chainHead = opts.chainHead ?? 100n
  const backoff = opts.backoff ?? createBackoff({ baseBlocks: 2n, maxBlocks: 64n })
  if (opts.seedBackoffAt !== undefined) backoff.record(LABEL, opts.seedBackoffAt)
  // Default disabled (0) so existing cases are unaffected; opt-in cases pass an enabled store.
  const cooldown = opts.cooldown ?? createCooldownStore({ cooldownMs: 0 })
  // 0n so every skip explains itself by default; throttling cases pass a real cadence.
  const planSkipSampler = opts.planSkipSampler ?? createBlockSampler(0n)
  const defaultOutcome: QuoteOutcome = opts.noSwap
    ? { kind: 'no_config' }
    : { kind: 'swap', plan: SWAP_PLAN }
  const deps = {
    discover: async () => {
      if (opts.discoverError) throw opts.discoverError
      return candidates(...(opts.borrowers ?? [BORROWER]))
    },
    chainHead,
    caller: CALLER,
    seizeCapMarginBps: opts.seizeCapMarginBps ?? 0,
    readLens: stubReadLens(opts.out === undefined ? lensOut() : opts.out),
    quoteFor: async () => {
      quoteCalls += 1
      return opts.quoteOutcome ?? defaultOutcome
    },
    simulate: async () => {
      simulateCalls += 1
      return opts.simulateResult ?? ({ status: 'ok' } as SimulateResult)
    },
    submit: async () => {
      submitCalls += 1
      if (opts.submitThrows) throw opts.submitThrows
      return opts.submitOutcome ?? SENT
    },
    backoff,
    cooldown,
    planSkipSampler,
    inflightLabels: () => opts.inflight ?? new Set<string>(),
    logger
  }
  return {
    deps,
    probes: {
      backoff,
      cooldown,
      planSkipSampler,
      simulateCalls: () => simulateCalls,
      submitCalls: () => submitCalls,
      quoteCalls: () => quoteCalls,
      events
    }
  }
}

function runWith(opts: RunOpts) {
  const { deps, probes } = buildDeps(opts)
  return runTick(deps).then(counters => {
    expectCountersConsistent(counters)
    return { counters, ...probes }
  })
}

/** For the abort path: `runTick` rejects, so counters come from the emitted `tick.end` instead. */
async function runExpectingThrow(opts: RunOpts) {
  const { deps, probes } = buildDeps(opts)
  await expect(runTick(deps)).rejects.toThrow()
  return probes
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
      ok: 1,
      reverted: 0,
      submitted: 1,
      notSent: 0
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
    expect(counters).toMatchObject({
      liquidatable: 1,
      inflightSkipped: 1,
      planSkipped: 0,
      planned: 0,
      submitted: 0
    })
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

  describe('unplannable positions (plan.skipped)', () => {
    // Post-maturity dust: 1 wei of debt against a high-priced slot, so the largest in-cap seize
    // rounds to 0 collateral. This is the production signature that went unexplained for 5 days.
    const DUST = () =>
      lensOut({
        healthy: true,
        blockTimestamp: 3000n,
        debt: 1n,
        badDebt: 0n,
        bestCollateralAmt: 10n ** 18n,
        bestCollateralPrice: 10n ** 37n
      })

    it('counts planSkipped instead of silently dropping a liquidatable position', async () => {
      const { counters, quoteCalls, simulateCalls, submitCalls } = await runWith({ out: DUST() })
      expect(counters).toMatchObject({
        liquidatable: 1,
        inflightSkipped: 0,
        planSkipped: 1,
        planned: 0,
        submitted: 0
      })
      expect(quoteCalls()).toBe(0)
      expect(simulateCalls()).toBe(0)
      expect(submitCalls()).toBe(0)
    })

    it('logs plan.skipped with a closed causal chain: sizing inputs AND the derived trace', async () => {
      const { events } = await runWith({ out: DUST() })
      const skipped = events.find(e => e.event === 'plan.skipped')
      expect(skipped?.level).toBe('info') // ordinary dust, not an invariant violation
      expect(skipped?.fields).toMatchObject({
        reason: 'seize_rounds_to_zero',
        marketId: MARKET,
        borrower: BORROWER,
        // derived (unknowable without replaying plan())
        postMaturityMode: true,
        lif: 1027777777777777777n,
        effectiveDebt: 1n,
        cap: 1n,
        capEff: 1n,
        seizedAssets: 0n,
        marginBps: 0,
        // inputs (so the line can be replayed offline)
        debt: 1n,
        badDebt: 0n,
        maturity: 2000n,
        bestCollateralAmt: 10n ** 18n,
        bestCollateralPrice: 10n ** 37n
      })
    })

    it('distinguishes the margin eating the cap from the division flooring', async () => {
      // Same 1-wei cap, but a 30bps margin floors capEff to 0: same reason, different numbers. Shows
      // the field set discriminates the sub-causes.
      const { events } = await runWith({ out: DUST(), seizeCapMarginBps: 30 })
      expect(events.find(e => e.event === 'plan.skipped')?.fields).toMatchObject({
        reason: 'seize_rounds_to_zero',
        cap: 1n,
        capEff: 0n,
        marginBps: 30
      })
    })

    it('warns on a non-positive cap and refuses the negative-seize plan', async () => {
      // debt - maxDebt (100) < badDebt (500) < debt (1000) makes the RCF numerator negative, so the
      // cap and the seize both go negative. Pre-fix this returned a NEGATIVE-seize plan.
      // rcfThreshold 0 so the slot is NOT rcf-exempt and the negative RCF cap actually binds.
      const { counters, events, submitCalls } = await runWith({
        out: lensOut({
          debt: 1000n,
          badDebt: 500n,
          maxDebt: 900n,
          market: { ...lensOut().market, rcfThreshold: 0n }
        }),
        chainHead: 100n
      })
      expect(counters).toMatchObject({ liquidatable: 1, planSkipped: 1, planned: 0 })
      const skipped = events.find(e => e.event === 'plan.skipped')
      expect(skipped?.level).toBe('warn') // should be impossible → alertable
      expect(skipped?.fields).toMatchObject({ reason: 'cap_not_positive', cap: -7406n })
      expect(submitCalls()).toBe(0)
    })

    it('emits one snapshot per sampler window, covering every offender in the tick', async () => {
      // Cadence of 150 blocks and two offenders: both explain on the first tick, neither on the next.
      const planSkipSampler = createBlockSampler(150n)
      const other: Address = getAddress('0x9999999999999999999999999999999999999999')
      const first = await runWith({
        out: DUST(),
        borrowers: [BORROWER, other],
        planSkipSampler,
        chainHead: 100n
      })
      expect(first.counters).toMatchObject({ liquidatable: 2, planSkipped: 2 })
      expect(first.events.filter(e => e.event === 'plan.skipped')).toHaveLength(2)

      const second = await runWith({
        out: DUST(),
        borrowers: [BORROWER, other],
        planSkipSampler,
        chainHead: 101n
      })
      expect(second.counters).toMatchObject({ planSkipped: 2 }) // still counted at full fidelity
      expect(second.events.filter(e => e.event === 'plan.skipped')).toHaveLength(0)
    })

    it('does not consume the sampler window on a tick with nothing to explain', async () => {
      // The edge-trigger guarantee: a clean tick must not spend the window, so the first skip after
      // any quiet stretch is always reported.
      const planSkipSampler = createBlockSampler(150n)
      const clean = await runWith({ planSkipSampler, chainHead: 100n })
      expect(clean.counters.planSkipped).toBe(0)
      const dirty = await runWith({ out: DUST(), planSkipSampler, chainHead: 101n })
      expect(dirty.events.filter(e => e.event === 'plan.skipped')).toHaveLength(1)
    })
  })

  describe('submit outcomes', () => {
    it('counts a broadcast as submitted and clears the backoff', async () => {
      const { counters, backoff } = await runWith({
        seedBackoffAt: 1n,
        submitOutcome: { kind: 'sent', nonce: 7, txHash: TX_HASH }
      })
      expect(counters).toMatchObject({ ok: 1, submitted: 1, notSent: 0 })
      expect(backoff.shouldSkip(LABEL, 1n)).toBe(false)
    })

    it('counts notSent and ACCUMULATES the backoff when the send failed for this position', async () => {
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      const { counters, backoff } = await runWith({
        cooldown,
        submitOutcome: { kind: 'failed', reason: 'submit_failed' }
      })
      expect(counters).toMatchObject({ ok: 1, submitted: 0, notSent: 1 })
      expect(backoff.shouldSkip(LABEL, 100n)).toBe(true)
      expect(cooldown.shouldSkip(LABEL)).toBe(true)
    })

    it('lets the backoff delay GROW across repeated send failures', async () => {
      // `clear` deletes the attempt count, so clearing on a non-broadcast pins the delay at
      // `baseBlocks` forever. Seeded at block 1 (attempts=1) then failing at 100 must reach
      // attempts=2 → a 4-block wait (until 104), not the 2-block wait a reset would give.
      const { backoff } = await runWith({
        seedBackoffAt: 1n,
        submitOutcome: { kind: 'failed', reason: 'submit_failed' }
      })
      expect(backoff.shouldSkip(LABEL, 103n)).toBe(true)
      expect(backoff.shouldSkip(LABEL, 104n)).toBe(false)
    })

    it.each(['send_aborted', 'nonce_hole', 'nonce_sync_failed'] as const)(
      'counts notSent but does NOT back off a queue-wide refusal (%s)',
      async reason => {
        // These refuse EVERY send this tick, so attributing one to the position in hand would
        // suppress positions that did nothing wrong.
        const cooldown = createCooldownStore({ cooldownMs: 60_000 })
        const { counters, backoff } = await runWith({
          cooldown,
          submitOutcome: { kind: 'failed', reason }
        })
        expect(counters).toMatchObject({ ok: 1, submitted: 0, notSent: 1 })
        expect(backoff.shouldSkip(LABEL, 100n)).toBe(false)
        expect(cooldown.shouldSkip(LABEL)).toBe(false)
      }
    )
  })

  describe('tick.end completeness', () => {
    it('marks a clean tick complete', async () => {
      const { events } = await runWith({})
      expect(events.find(e => e.event === 'tick.end')?.fields).toMatchObject({
        complete: true,
        submitted: 1
      })
    })

    it('still emits tick.end with complete:false when a submit aborts the tick', async () => {
      // A hashless send after the nonce was claimed throws by design; pre-fix the throw escaped
      // before `tick.end`, so the tick's counters vanished.
      const { events } = await runExpectingThrow({ submitThrows: new Error('rpc timeout') })
      const end = events.find(e => e.event === 'tick.end')
      expect(end?.fields).toMatchObject({
        complete: false,
        liquidatable: 1,
        planned: 1,
        ok: 1,
        submitted: 0,
        notSent: 0
      })
    })
  })

  describe('lens.read', () => {
    it('counts rows the lens returned as invalid', async () => {
      const { counters, events } = await runWith({ out: lensOut({ valid: false }) })
      expect(events.find(e => e.event === 'lens.read')?.fields).toEqual({
        pairs: 1,
        returned: 1,
        invalid: 1
      })
      expect(counters).toMatchObject({ pairs: 1, liquidatable: 0 })
    })

    it('reports zero invalid for a healthy batch', async () => {
      const { events } = await runWith({})
      expect(events.find(e => e.event === 'lens.read')?.fields).toEqual({
        pairs: 1,
        returned: 1,
        invalid: 0
      })
    })
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
})
