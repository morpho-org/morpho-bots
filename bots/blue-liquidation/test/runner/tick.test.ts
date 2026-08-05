import type { Logger, SimulateResult, SubmitOutcome } from '@repo/bot-kit'
import type { Backoff, BlockSampler, CooldownStore } from '@repo/bot-kit'
import type { QuoteOutcome, SwapPlan } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { createBackoff, createBlockSampler, createCooldownStore } from '@repo/bot-kit'
import { lensKey } from '@repo/utils'
import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { BorrowerCandidate } from '../../src/discovery/borrowers'
import type { MarketParams } from '../../src/market'
import type { LensInput, LensOut } from '../../src/state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { marketId } from '../../src/market'
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
const LOAN: Address = getAddress('0x3333333333333333333333333333333333333333')
const COLL: Address = getAddress('0x4444444444444444444444444444444444444444')
const ORACLE: Address = getAddress('0x5555555555555555555555555555555555555555')
const IRM: Address = getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687')
const ROUTER: Address = getAddress('0x6666666666666666666666666666666666666666')

const PARAMS: MarketParams = {
  loanToken: LOAN,
  collateralToken: COLL,
  oracle: ORACLE,
  irm: IRM,
  lltv: 86n * 10n ** 16n
}
const LABEL = lensKey(marketId(PARAMS), BORROWER)
const MARKET_ID = marketId(PARAMS)
const TX_HASH: Hex = `0x${'b'.repeat(64)}`
const SENT: SubmitOutcome = { kind: 'sent', nonce: 7, txHash: TX_HASH }

type TickCounters = Awaited<ReturnType<typeof runTick>>

/**
 * Every counter identity the tick promises for a completed tick. Asserted for EVERY case built by
 * `runWith`, so a stage added without a counter breaks the sums instead of silently dropping a
 * position — the exact class of bug these counters exist to catch.
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
      tokenIn: PARAMS.collateralToken,
      tokenOut: PARAMS.loanToken,
      target: ROUTER,
      value: 0n,
      callData: '0xabcdef',
      amountIn: { source: 'balance', offset: 132n },
      approvalSpender: ROUTER
    }
  ],
  expectedAmountOut: 2000n * WAD,
  amountOutMinimum: 1n
}

// A liquidatable reading: valid, has debt, unhealthy, ample collateral (debt-binds → seize > 0).
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

  it('skips a non-liquidatable (healthy) pair without simulating or submitting', async () => {
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

  it('counts a degenerate collateral-less position as planSkipped', async () => {
    const { counters, quoteCalls, submitCalls, events } = await runWith({
      out: lensOut({ collateral: 0n })
    })
    expect(counters).toMatchObject({
      liquidatable: 1,
      planSkipped: 1,
      planned: 0,
      submitted: 0
    })
    expect(quoteCalls()).toBe(0)
    expect(submitCalls()).toBe(0)
    const skipped = events.find(e => e.event === 'plan.skipped')
    expect(skipped?.level).toBe('info') // documented residual-bad-debt degenerate
    expect(skipped?.fields).toMatchObject({ reason: 'no_collateral' })
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
    it('logs plan.skipped with a closed causal chain: sizing inputs AND the derived trace', async () => {
      // Dust: a tiny debt against an expensive slot floors the full-debt seize to zero collateral.
      const { counters, events } = await runWith({
        out: lensOut({ borrowShares: 1n, collateralPrice: ORACLE_PRICE_SCALE * 10n ** 6n })
      })
      expect(counters).toMatchObject({ liquidatable: 1, planSkipped: 1, planned: 0 })
      const skipped = events.find(e => e.event === 'plan.skipped')
      expect(skipped?.level).toBe('info')
      expect(skipped?.fields).toMatchObject({
        reason: 'seize_rounds_to_zero',
        marketId: MARKET_ID,
        borrower: BORROWER,
        // derived
        seizedAssets: 0n,
        // inputs, so the line replays offline
        borrowShares: 1n,
        collateral: 5000n * WAD,
        lltv: PARAMS.lltv
      })
      expect(skipped?.fields).toHaveProperty('lif')
      expect(skipped?.fields).toHaveProperty('repaidAssetsFull')
      expect(skipped?.fields).toHaveProperty('seizeForFullDebt')
    })

    it('warns on a non-reverting zero oracle price', async () => {
      const { counters, events } = await runWith({ out: lensOut({ collateralPrice: 0n }) })
      expect(counters).toMatchObject({ liquidatable: 1, planSkipped: 1, planned: 0 })
      const skipped = events.find(e => e.event === 'plan.skipped')
      expect(skipped?.level).toBe('warn') // a market anomaly, not routine dust
      expect(skipped?.fields).toMatchObject({ reason: 'zero_price' })
    })

    it('emits one snapshot per sampler window, covering every offender in the tick', async () => {
      const planSkipSampler = createBlockSampler(150n)
      const other: Address = getAddress('0x9999999999999999999999999999999999999999')
      const first = await runWith({
        out: lensOut({ collateral: 0n }),
        borrowers: [BORROWER, other],
        planSkipSampler,
        chainHead: 100n
      })
      expect(first.counters).toMatchObject({ liquidatable: 2, planSkipped: 2 })
      expect(first.events.filter(e => e.event === 'plan.skipped')).toHaveLength(2)

      const second = await runWith({
        out: lensOut({ collateral: 0n }),
        borrowers: [BORROWER, other],
        planSkipSampler,
        chainHead: 101n
      })
      expect(second.counters).toMatchObject({ planSkipped: 2 }) // still counted at full fidelity
      expect(second.events.filter(e => e.event === 'plan.skipped')).toHaveLength(0)
    })

    it('does not consume the sampler window on a tick with nothing to explain', async () => {
      const planSkipSampler = createBlockSampler(150n)
      const clean = await runWith({ planSkipSampler, chainHead: 100n })
      expect(clean.counters.planSkipped).toBe(0)
      const dirty = await runWith({
        out: lensOut({ collateral: 0n }),
        planSkipSampler,
        chainHead: 101n
      })
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
      // The precise mechanism of bug 3: `clear` deletes the attempt count, so clearing on a
      // non-broadcast resets the delay to `baseBlocks` forever and the exponential never accrues.
      // Seeded at block 1 (attempts=1) and failing again at 100 must reach attempts=2 → a 4-block
      // wait (until 104), not the 2-block wait a reset would give.
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
      const { events } = await runExpectingThrow({ submitThrows: new Error('rpc timeout') })
      expect(events.find(e => e.event === 'tick.end')?.fields).toMatchObject({
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
