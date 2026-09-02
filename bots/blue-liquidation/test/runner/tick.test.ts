import type { Logger, SimulateResult, SubmitOutcome } from '@repo/bot-kit'
import type { CooldownStore } from '@repo/bot-kit'
import type { QuoteOutcome, SwapPlan } from '@repo/swaps'
import type { Address } from 'viem'

import { createBackoff, createCooldownStore, createPendingQueue, TxSendError } from '@repo/bot-kit'
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

// The sums documented on TickCounters. Asserted rather than eyeballed so a new loop exit that forgets
// its counter fails a test instead of silently dropping a position from the tally.
const expectCounterIdentities = (c: Record<string, number>) => {
  expect(c.pairs).toBeGreaterThanOrEqual(c.liquidatable!)
  expect(c.liquidatable).toBe(c.inflightSkipped! + c.planSkipped! + c.planned!)
  // One collateral per Blue market, so one position is one candidate and `planned` heads this sum.
  expect(c.planned).toBe(
    c.cooledDown! + c.backoffSkipped! + c.noSwapPath! + c.quoteFailed! + c.ok! + c.reverted!
  )
  expect(c.ok).toBe(c.submitted! + c.notSent!)
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
  cooldown?: CooldownStore
  /** Models the queue's outcome; the two no-broadcast reasons are NOT interchangeable. */
  submitOutcome?: SubmitOutcome
  /** Models a send that claimed a nonce but produced no hash, which aborts the tick. */
  submitThrows?: Error
  /** Shared spy, so a caller can observe the tick's and the queue's events in ONE stream. */
  spy?: ReturnType<typeof spyLogger>
  /** Replaces the stub `submit` — used to broadcast through a real pending queue. */
  submitWith?: (args: { label: string; blockNumber: bigint }) => Promise<SubmitOutcome>
}) {
  const { logger, events } = opts.spy ?? spyLogger()
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
    readLens: stubReadLens(opts.out === undefined ? lensOut() : opts.out),
    quoteFor: async () => {
      quoteCalls += 1
      return opts.quoteOutcome ?? defaultOutcome
    },
    simulate: async () => {
      simulateCalls += 1
      return opts.simulateResult ?? { status: 'ok' }
    },
    submit: async args => {
      submitCalls += 1
      if (opts.submitThrows) throw opts.submitThrows
      if (opts.submitWith) return opts.submitWith(args)
      return opts.submitOutcome ?? { sent: true }
    },
    backoff,
    cooldown,
    inflightLabels: () => opts.inflight ?? new Set(),
    logger
  })
  return result.then(counters => ({
    counters,
    backoff,
    cooldown,
    simulateCalls: () => simulateCalls,
    submitCalls: () => submitCalls,
    quoteCalls: () => quoteCalls,
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
      ok: 1,
      reverted: 0,
      submitted: 1,
      notSent: 0
    })
    expect(simulateCalls()).toBe(1)
    expect(submitCalls()).toBe(1)
    expectCounterIdentities(counters)
  })

  it('emits tick.end with complete: true and the full counter bag', async () => {
    const { counters, events } = await runWith({})
    const end = events.find(e => e.event === 'tick.end')
    expect(end?.level).toBe('info')
    expect(end?.fields).toEqual({ ...counters, complete: true })
  })

  it('emits tick.end with complete: false when a submit aborts the tick', async () => {
    // The real failure the queue documents for this path: a first send that claimed a nonce but
    // produced no hash. Using the exported type keeps the fixture honest if the tick ever
    // discriminates on it.
    const { logger, events } = spyLogger()
    await expect(
      runWith({
        spy: { logger, events },
        submitThrows: new TxSendError('nonce claimed, no hash', 7)
      })
    ).rejects.toThrow('nonce claimed, no hash')
    const end = events.find(e => e.event === 'tick.end')
    // `ok === submitted + notSent` is intentionally short by one here: the throw lands after `ok` was
    // counted and before either term is — which is exactly what `complete: false` flags.
    expect(end?.fields).toMatchObject({ ok: 1, submitted: 0, notSent: 0, complete: false })
  })

  it('does not submit a reverting plan and backs the position off', async () => {
    const { counters, submitCalls, backoff } = await runWith({
      simulateResult: { status: 'revert', reason: 'amountOutMinimum not met' }
    })
    expect(counters.reverted).toBe(1)
    expect(counters.submitted).toBe(0)
    expect(submitCalls()).toBe(0)
    expect(backoff.shouldSkip(LABEL, 100n)).toBe(true)
    expectCounterIdentities(counters)
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
    expectCounterIdentities(counters)
  })

  it('counts a failed quote, backs the position off, and never simulates', async () => {
    const { counters, simulateCalls, submitCalls, backoff } = await runWith({
      quoteOutcome: { kind: 'failed', reason: 'no_route' }
    })
    expect(counters).toMatchObject({ liquidatable: 1, planned: 1, quoteFailed: 1, submitted: 0 })
    expect(simulateCalls()).toBe(0)
    expect(submitCalls()).toBe(0)
    expect(backoff.shouldSkip(LABEL, 100n)).toBe(true)
    expectCounterIdentities(counters)
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
    expectCounterIdentities(counters)
  })

  it('clears backoff on a successful submit', async () => {
    const { backoff } = await runWith({ seedBackoffAt: 1n, simulateResult: { status: 'ok' } })
    // Seeded at block 1 (cooldown until 3) so it didn't suppress this tick at 100; the submit clears it.
    expect(backoff.shouldSkip(LABEL, 1n)).toBe(false)
  })

  it('skips a position already in flight without re-quoting, simulating, or submitting', async () => {
    const { counters, quoteCalls, simulateCalls, submitCalls, events } = await runWith({
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
    // Not a sizing skip: the queue narrates an in-flight label end to end already.
    expect(events.some(e => e.event === 'plan.skipped')).toBe(false)
    expectCounterIdentities(counters)
  })

  it('skips a non-liquidatable (healthy) pair without simulating or submitting', async () => {
    const { counters, simulateCalls, submitCalls } = await runWith({
      out: lensOut({ healthy: true })
    })
    expect(counters).toMatchObject({ pairs: 1, liquidatable: 0, planned: 0, submitted: 0 })
    expect(simulateCalls()).toBe(0)
    expect(submitCalls()).toBe(0)
    expectCounterIdentities(counters)
  })

  it('skips a pair the lens did not return', async () => {
    const { counters, submitCalls } = await runWith({ out: null })
    expect(counters).toMatchObject({ pairs: 1, liquidatable: 0, submitted: 0 })
    expect(submitCalls()).toBe(0)
  })

  describe('sizing skips', () => {
    it('reports a collateral-less position as plan.skipped / no_collateral at info', async () => {
      const cooldown = createCooldownStore({ cooldownMs: 60_000 })
      const { counters, quoteCalls, submitCalls, events, backoff } = await runWith({
        cooldown,
        out: lensOut({ collateral: 0n })
      })
      expect(counters).toMatchObject({ liquidatable: 1, planSkipped: 1, planned: 0, submitted: 0 })
      expect(quoteCalls()).toBe(0)
      expect(submitCalls()).toBe(0)
      const skipped = events.find(e => e.event === 'plan.skipped')
      expect(skipped?.level).toBe('info')
      expect(skipped?.fields).toEqual({
        id: LABEL,
        marketId: marketId(PARAMS),
        borrower: BORROWER,
        reason: 'no_collateral'
      })
      // A sizing skip is not a failure: the next lens reading re-derives it for free.
      expect(backoff.shouldSkip(LABEL, 100n)).toBe(false)
      expect(cooldown.shouldSkip(LABEL)).toBe(false)
      expectCounterIdentities(counters)
    })

    it('reports a non-reverting zero oracle price at warn, as a market anomaly', async () => {
      const { counters, events } = await runWith({ out: lensOut({ collateralPrice: 0n }) })
      expect(counters).toMatchObject({ liquidatable: 1, planSkipped: 1, planned: 0 })
      const skipped = events.find(e => e.event === 'plan.skipped')
      expect(skipped?.level).toBe('warn')
      expect(skipped?.fields).toMatchObject({ id: LABEL, reason: 'zero_price' })
      expectCounterIdentities(counters)
    })

    it('reports a dust position whose seize floors to zero at info', async () => {
      const { counters, events, quoteCalls } = await runWith({
        out: lensOut({ borrowShares: 1n })
      })
      expect(counters).toMatchObject({ liquidatable: 1, planSkipped: 1, planned: 0 })
      expect(quoteCalls()).toBe(0)
      const skipped = events.find(e => e.event === 'plan.skipped')
      expect(skipped?.level).toBe('info')
      expect(skipped?.fields).toMatchObject({ id: LABEL, reason: 'seize_rounds_to_zero' })
      expectCounterIdentities(counters)
    })

    it('emits no plan.skipped for a planned position', async () => {
      const { counters, events } = await runWith({})
      expect(counters).toMatchObject({ planSkipped: 0, planned: 1 })
      expect(events.some(e => e.event === 'plan.skipped')).toBe(false)
    })
  })

  it('tolerates a discovery failure: logs discover.error and submits nothing', async () => {
    const { counters, events, submitCalls } = await runWith({
      discoverError: new Error('boom')
    })
    expect(counters).toMatchObject({ pairs: 0, liquidatable: 0, submitted: 0 })
    expect(events.some(e => e.level === 'warn' && e.event === 'discover.error')).toBe(true)
    expect(submitCalls()).toBe(0)
    expectCounterIdentities(counters)
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
      expectCounterIdentities(counters)
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
  describe('submit outcome', () => {
    it('keeps the failure history but records nothing when the QUEUE refused', async () => {
      // Seeded at block 1 (suppressed until 3) so it does not suppress this tick at 100. A queue-wide
      // refusal says nothing about this position, so its history survives un-extended.
      const { counters, backoff, submitCalls } = await runWith({
        seedBackoffAt: 1n,
        submitOutcome: { sent: false, reason: 'refused' }
      })
      expect(submitCalls()).toBe(1)
      expect(counters).toMatchObject({ ok: 1, submitted: 0, notSent: 1 })
      expect(backoff.shouldSkip(LABEL, 1n)).toBe(true)
      expectCounterIdentities(counters)
      // Not re-armed: the next block may try again, which is the point of not blaming the position.
      expect(backoff.shouldSkip(LABEL, 101n)).toBe(false)
    })

    it("re-arms backoff when THIS position's send was rejected", async () => {
      // The send itself failed, which is a fact about this position. Reaching submit at all means any
      // earlier entry had expired, so leaving it untouched would suppress nothing and the next block
      // would re-quote, re-simulate and re-send.
      const { counters, backoff } = await runWith({
        seedBackoffAt: 1n,
        submitOutcome: { sent: false, reason: 'send_failed', executionRevert: false }
      })
      expect(counters).toMatchObject({ ok: 1, submitted: 0, notSent: 1 })
      expect(backoff.shouldSkip(LABEL, 101n)).toBe(true)
    })

    it("keeps backoff on an execution-reverted send: blue's incentive is static", async () => {
      // Pins the divergence documented at the backoff.record call in src/runner/tick.ts: midnight
      // exempts this case, blue must not.
      const { counters, backoff } = await runWith({
        seedBackoffAt: 1n,
        submitOutcome: { sent: false, reason: 'send_failed', executionRevert: true }
      })
      expect(counters).toMatchObject({ ok: 1, submitted: 0, notSent: 1 })
      expect(backoff.shouldSkip(LABEL, 101n)).toBe(true)
    })

    it('clears backoff and counts submitted only when the queue broadcast', async () => {
      const { counters, backoff } = await runWith({
        seedBackoffAt: 1n,
        submitOutcome: { sent: true }
      })
      expect(counters).toMatchObject({ ok: 1, submitted: 1, notSent: 0 })
      expect(backoff.shouldSkip(LABEL, 1n)).toBe(false)
      expectCounterIdentities(counters)
    })
  })
  it('emits one id that joins plan.built to the queue tx.sent', async () => {
    // BOTS-90's acceptance criterion as a test: grouping a window's events by `id` must not split one
    // position. Broadcast through the REAL queue, since the split was between the tick's field name
    // and the queue's — a stubbed submit cannot see it.
    const spy = spyLogger()
    const queue = createPendingQueue({
      send: async () => ({ nonce: 7, txHash: `0x${'1'.repeat(64)}` }),
      getReceipt: async () => null,
      getBaseFee: async () => 1n,
      maxFeeWei: 10n ** 18n,
      logger: spy.logger
    })
    await runWith({
      spy,
      submitWith: ({ label, blockNumber }) =>
        queue.submit({
          request: { to: ROUTER, data: '0x' },
          label,
          maxFeePerGas: 1000n,
          maxPriorityFeePerGas: 1000n,
          blockNumber
        })
    })
    const planBuilt = spy.events.find(e => e.event === 'plan.built')
    const txSent = spy.events.find(e => e.event === 'tx.sent')
    expect(planBuilt?.fields?.id).toBe(LABEL)
    expect(txSent?.fields?.id).toBe(planBuilt?.fields?.id)
  })
})
