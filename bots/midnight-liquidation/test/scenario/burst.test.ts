import type { TxPayload } from '@repo/kernel'
import type { QuoteOutcome } from '@repo/swaps'

import { FakeChain } from '@repo/kernel/testing'
import { venuePairKey } from '@repo/swaps'
import { createTokenBucket } from '@repo/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Position } from './bot'

import { MAX_PRESELECTED_CANDIDATES_PER_POSITION } from '../../src/constants'
import { MAX_PLAN_CANDIDATES_PER_POSITION } from '../../src/sizing/plan'
import { borrowerAt, collateralAt, EXECUTOR, LOAN, positionKey, startBot } from './bot'

type Bot = Awaited<ReturnType<typeof startBot>>

const bots: Bot[] = []
beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 })
})
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.shutdown()
  vi.useRealTimers()
})

/** Moves fake time until `done`, failing once `limitMs` of it has passed; `each` runs every step. */
const advanceUntil = async (
  done: () => boolean,
  what: string,
  {
    limitMs,
    stepMs = 5,
    each = () => {}
  }: Readonly<{ limitMs: number; stepMs?: number; each?: () => void }>
) => {
  for (let spent = 0; !done(); spent += stepMs) {
    if (spent >= limitMs) throw new Error(`no ${what} within ${limitMs} ms of fake time`)
    await vi.advanceTimersByTimeAsync(stepMs)
    each()
  }
}

/** Moves fake time until a 2s window passes with no firm quote asked. */
const quiesce = async (bot: Bot) => {
  for (let quotes = -1; quotes !== bot.world.quotes; ) {
    quotes = bot.world.quotes
    await vi.advanceTimersByTimeAsync(2_000)
  }
}

const started = async (parameters: Parameters<typeof startBot>[0]) => {
  const bot = await startBot(parameters)
  bots.push(bot)
  await advanceUntil(() => bot.state().lifecycle.kind === 'running', 'running kernel', {
    limitMs: 10_000
  })
  return bot
}

/** Every key the family has backed off, as its backoff state holds them; sample it each step. */
const backedOff = (bot: Bot, seen: Set<string>) => () => {
  for (const [key, tasks] of Object.entries(bot.runner.read(bot.nodes.backoff.state)?.keys ?? {}))
    if (Object.values(tasks).some(entry => entry.failures > 0)) seen.add(key)
}

const keyOf = (position: Position) => positionKey(position.market, position.borrower)
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const SWAP = { steps: [], expectedAmountOut: 10n ** 30n, amountOutMinimum: 1n }
const SHORT: QuoteOutcome = { kind: 'failed', reason: 'floor_unmet', firmCalls: 1 }
const BASE_BLOCK_MS = 2_000

const report = (name: string, fields: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ [name]: fields })}\n`)

describe('a maturity burst on the reconciler', () => {
  const MARKETS = 100
  const POSITIONS = 24
  /** Blocks before the maturity every listed market shares. */
  const LEAD = 3
  /** #358's measured floor, with 4 reservations. */
  const SETTLEMENTS_PER_CYCLE = 3.2

  /** `POSITIONS` healthy borrowers spread over the listed markets, every third holding two slots. */
  const burst = () =>
    new Map(
      Array.from({ length: POSITIONS }, (_, index): [string, Position] => {
        const position = {
          market: (index * 7) % MARKETS,
          borrower: borrowerAt(index),
          slots: index % 3 === 0 ? [0, 1] : [0],
          unhealthy: false
        }
        return [keyOf(position), position]
      })
    )

  // A 4s quote runs at Base's own 2s blocks, so it spans two blocks as it would in production.
  it.each([
    { quoteMs: 0, blockMs: 40 },
    { quoteMs: 20, blockMs: 40 },
    { quoteMs: 4_000, blockMs: BASE_BLOCK_MS }
  ])(
    'settles every liquidation at the reservations’ pace, with no wasted quote, refusal, fill or stop: quotes $quoteMs ms, blocks $blockMs ms',
    async ({ quoteMs, blockMs }) => {
      const chain = new FakeChain()
      const alive = burst()
      const liquidations = [...alive.values()].reduce((sum, p) => sum + p.slots.length, 0)
      const maturity = BigInt((chain.height + LEAD) * 2)
      const bot = await started({ chain, alive, markets: MARKETS, maturity, quoteMs, blockMs })
      let stopped: unknown
      bot.runner.stopped.then(
        value => (stopped = value ?? 'stopped'),
        (error: unknown) => (stopped = error)
      )
      const fills: TxPayload[] = []
      const mined = chain.onMined!
      chain.onMined = (payload, block) => {
        if (payload.to !== EXECUTOR) fills.push(payload)
        return mined(payload, block)
      }
      const firstBlock = chain.height + LEAD
      const backoffs = new Set<string>()
      /** Each kernel plan's last status seen; a plan is pruned once its nonce is final. */
      const outcomes = new Map<string, string>()
      const sampleBackoffs = backedOff(bot, backoffs)
      const observe = () => {
        sampleBackoffs()
        for (const [id, plan] of Object.entries(bot.state().plans)) outcomes.set(id, plan.status)
      }
      bot.mining(true)
      await advanceUntil(() => alive.size === 0, 'empty book', {
        limitMs: 600_000,
        stepMs: 5,
        each: observe
      })

      const blocks = [...chain.included].filter(([height]) => height >= firstBlock)
      const txs = blocks.flatMap(([, block]) => block)
      const settled = txs.filter(tx => tx.status === 'success').length
      await advanceUntil(() => Object.keys(bot.state().plans).length === 0, 'every plan pruned', {
        limitMs: 60_000,
        stepMs: 5,
        each: observe
      })
      const lastBlock = Math.max(
        ...blocks.filter(([, block]) => block.some(tx => tx.status === 'success')).map(([h]) => h)
      )
      const span = lastBlock - firstBlock + 1
      /** The blocks one reservation is held at least: its quote, then inclusion at the next block. */
      const cycle = Math.floor(quoteMs / blockMs) + 1
      report('burst', {
        quoteMs,
        blockMs,
        liquidations,
        blocks: span,
        settlementsPerBlock: settled / span,
        settlementsPerCycle: (settled * cycle) / span,
        quotes: bot.world.quotes,
        predatesOwnEffect: bot
          .events('liquidation.not_sent')
          .filter(line => String(line.fields.reason).includes('predates our own')).length
      })
      expect(settled).toBe(liquidations)
      expect(txs.length).toBe(settled)
      expect([...outcomes.values()]).toStrictEqual(Array(liquidations).fill('settled'))
      expect((settled * cycle) / span).toBeGreaterThanOrEqual(SETTLEMENTS_PER_CYCLE)
      expect(bot.world.quotes - settled).toBe(0)
      expect(backoffs).toStrictEqual(new Set())
      expect(fills).toStrictEqual([])
      expect(stopped).toBeUndefined()
      expect(bot.state().lifecycle.kind).toBe('running')
    },
    60_000
  )
})

type Http = Readonly<{ rps: number; burst: number }>

/**
 * When a call asked at `now` may start under a bucket of `burst` calls refilled at `rps`, for calls
 * that ask in order, as the generic cell rate algorithm schedules them; `bucket.due` is when the
 * bucket is next full.
 */
const startAt = (http: Http, bucket: { due: number }, now: number) => {
  const interval = 1_000 / http.rps
  const start = Math.max(now, bucket.due - (http.burst - 1) * interval)
  bucket.due = Math.max(bucket.due, start) + interval
  return start
}

/**
 * When each call starts, from the first, were calls started strictly in the given order on `slots`
 * slots through the same client: `main`'s global interleaving, on the reconciler's resources.
 */
const startsInOrder = (latencies: readonly number[], slots: number, http?: Http) => {
  const free = Array.from({ length: slots }, () => 0)
  const bucket = { due: 0 }
  let previous = 0
  return latencies.map(latency => {
    const lane = free.indexOf(Math.min(...free))
    const ready = Math.max(previous, free[lane]!)
    const start = http ? startAt(http, bucket, ready) : ready
    free[lane] = start + latency
    previous = start
    return start
  })
}

/**
 * D4's ordering check. Positions A–D each rank first on a large slot whose firm quote fails, with
 * three low-value fallback slots that fall short of their floor; E's one slot is worth less than
 * A–D's best and more than any fallback, so `main`'s global order quotes it fifth.
 */
describe('the ordering of a better position behind failing ones (D4)', () => {
  /** The latency of a first attempt and of E's: one attempt, D4's bound on E's delay. */
  const ATTEMPT_MS = 1_000
  /** The harness kernel's reservations, which also bound the preparations the family runs at once. */
  const RESERVATIONS = 4
  type Variant = Readonly<{ costed: boolean; fallbackMs: number; http?: Http; lanes?: number }>

  const measure = async ({ costed, fallbackMs, http, lanes = 4 }: Variant) => {
    const failing = Array.from(
      { length: 4 },
      (_, market): Position => ({
        market,
        borrower: borrowerAt(10 + market),
        slots: [0, 2, 3, 4],
        amounts: { 0: 800n, 2: 20n, 3: 20n, 4: 20n },
        unhealthy: true
      })
    )
    const better: Position = {
      market: 4,
      borrower: borrowerAt(14),
      slots: [0],
      amount: 400n,
      unhealthy: true
    }
    const positions = [...failing, better]
    const alive = new Map(positions.map(position => [keyOf(position), position]))
    const phase = { warm: true }
    const bucket = http && createTokenBucket({ ...http, now: Date.now, sleep })
    const calls: { key: string; slot: number; at: number }[] = []
    const bot = await started({
      alive,
      markets: positions.length,
      concurrency: lanes,
      ...(costed && { routeCostBps: () => 10 }),
      ...(http && { venueBudget: { calls: http.rps, perMs: 1_000 } }),
      quote: async (plan, key) => {
        if (phase.warm) return SHORT
        await bucket?.take()
        const first = plan.collateralIndex === 0
        calls.push({ key, slot: plan.collateralIndex, at: Date.now() })
        await sleep(first ? ATTEMPT_MS : fallbackMs)
        if (key === keyOf(better)) return { kind: 'swap', plan: SWAP, firmCalls: 1 }
        return first ? { kind: 'failed', reason: 'no_route', firmCalls: 1 } : SHORT
      }
    })
    // A production curve changes only when re-probed; one rewritten at every head would restart
    // every preparation in flight.
    bot.world.curvesAt = Date.now()
    bot.chain.mine()
    const curved = () =>
      positions.every(position =>
        position.slots.every(
          slot =>
            bot.runner.read(bot.nodes.curves)?.keys[
              venuePairKey({ collateral: collateralAt(position.market, slot), loan: LOAN })
            ]?.status === 'present'
        )
      )
    await advanceUntil(
      () =>
        [...alive.keys()].every(key => bot.world.quotedBy.includes(key)) && (!costed || curved()),
      'warm curves',
      { limitMs: 30_000 }
    )
    await quiesce(bot)
    phase.warm = false
    bot.chain.mine()
    await advanceUntil(() => calls.some(call => call.key === keyOf(better)), 'quote for E', {
      limitMs: 60_000
    })

    const e = calls.findIndex(call => call.key === keyOf(better))
    const attempted = () =>
      failing.map(
        position =>
          new Set(calls.filter(call => call.key === keyOf(position)).map(c => c.slot)).size
      )
    const allowed = costed
      ? MAX_PRESELECTED_CANDIDATES_PER_POSITION
      : MAX_PLAN_CANDIDATES_PER_POSITION
    await advanceUntil(
      () => attempted().every(count => count >= allowed),
      'every alternative A–D may attempt',
      { limitMs: 60_000 }
    )
    const start = calls[e]!.at - calls[0]!.at
    const firstAttempts = Array<number>(failing.length + 1).fill(ATTEMPT_MS)
    // D4 gates on `main`'s serial phase B; the same-resources global order is reported beside it.
    const inOrder = startsInOrder(firstAttempts, Math.min(lanes, RESERVATIONS), http).at(-1)!
    const measured = {
      start,
      inOrder,
      delay: start - inOrder,
      serialMain: startsInOrder(firstAttempts, 1, http).at(-1)!,
      fallbacksBefore: calls.slice(0, e).filter(call => call.slot !== 0).length,
      callsBefore: e,
      attempted: attempted()
    }
    report('ordering', { costed, fallbackMs, http, lanes, ...measured })
    return measured
  }

  const COSTED_FAST = { costed: true, fallbackMs: 100 }
  /** Twice the lanes the reservations can fill, so the venue has capacity to spare. */
  const COSTED_SLOW = { costed: true, fallbackMs: 4_000, lanes: 2 * RESERVATIONS }
  const UNCOSTED = { costed: false, fallbackMs: 100 }
  const HTTP_BOUND = { costed: true, fallbackMs: 100, http: { rps: 1, burst: 1 } }
  const HTTP_BOUND_START_MS = 8_000

  it.each([
    ['costed, fast fallbacks', COSTED_FAST, [2, 2, 2, 2]],
    ['uncosted, every alternative attempted', UNCOSTED, [4, 4, 4, 4]],
    ['costed, slow fallbacks', COSTED_SLOW, [2, 2, 2, 2]]
  ])(
    'starts E within one attempt of `main`’s serial schedule: %s',
    async (_, variant, perPosition) => {
      const { start, serialMain, attempted } = await measure(variant)
      expect(start).toBeLessThanOrEqual(serialMain + ATTEMPT_MS)
      expect(attempted).toStrictEqual(perPosition)
    },
    60_000
  )

  // D4's accepted limitation: A–D's fallbacks take HTTP tokens ahead of E's first call.
  it('starts E no later than today under a binding HTTP budget', async () => {
    expect((await measure(HTTP_BOUND)).start).toBeLessThanOrEqual(HTTP_BOUND_START_MS)
  }, 60_000)
})
