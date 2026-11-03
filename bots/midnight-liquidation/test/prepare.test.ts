import type { PrepareRequest } from '@repo/controller'
import type { Logger } from '@repo/kit'
import type { QuoteOutcome, SwapPlan } from '@repo/swaps'
import type { Hex } from 'viem'

import { firstBid } from '@repo/kit'
import { parseGwei } from 'viem'
import { describe, expect, it } from 'vitest'

import type { PositionReading } from '../src/liquidation'
import type { PrepareDeps } from '../src/prepare'
import type { LiquidationPlan } from '../src/sizing/plan'

import { preparePosition } from '../src/prepare'
import { createTickStats } from '../src/stats'
import {
  EXECUTOR,
  FAR_MATURITY,
  marketIdAt,
  NATIVE,
  outAt,
  PRICES,
  pricingFor,
  readingsOf,
  unhealthy
} from './scenario/bot'

const swap: SwapPlan = { steps: [], expectedAmountOut: 10n ** 30n, amountOutMinimum: 1n }

/** A position unhealthy before maturity, holding the swap slot 0 and the loan-token slot 1. */
const request = (slots = [0, 1]): PrepareRequest<PositionReading> => {
  const position = unhealthy(0, 1, slots)
  return {
    id: 'run.p0',
    key: 'k',
    task: 'liquidate',
    version: 'v',
    seq: 0,
    input: {
      marketId: marketIdAt(0),
      borrower: position.borrower,
      out: outAt(position, 100n, FAR_MATURITY),
      block: 41
    }
  }
}

type Line = { event: string; fields: Record<string, unknown> }

const FREE_FEES = {
  l1Data: 0n,
  baseFee: 0n,
  gasLimit: 0n,
  firstBid: () => ({ maxFeePerGas: 0n, gas: 0n })
}
/** Fees whose first bid keeps its gas limit from a spend bound of `executionWei` up. */
const feesNeeding = (executionWei: bigint, l1Data = 0n) => ({
  ...FREE_FEES,
  l1Data,
  gasLimit: 1n,
  firstBid: (spendWei: bigint) => ({ maxFeePerGas: 0n, gas: spendWei >= executionWei ? 1n : 0n })
})

const harness = (
  overrides: Partial<PrepareDeps> & {
    quotes?: (plan: LiquidationPlan) => QuoteOutcome
    simulates?: (plan: LiquidationPlan) => 'ok' | 'revert'
  } = {}
) => {
  const lines: Line[] = []
  const log = (event: string, fields: Record<string, unknown> = {}) => lines.push({ event, fields })
  const logger: Logger = { debug: log, info: log, warn: log, error: log }
  const stats = createTickStats()
  const attempted: number[] = []
  let last: LiquidationPlan | undefined
  const deps: PrepareDeps = {
    executor: EXECUTOR,
    sizing: { seizeCapMarginBps: 0, headroomFloorBps: 0 },
    minSurplusBps: 0,
    quoteFor: async plan => overrides.quotes?.(plan) ?? { kind: 'swap', plan: swap, firmCalls: 1 },
    encode: (_market, _borrower, plan) => {
      last = plan
      attempted.push(plan.collateralIndex)
      return '0xabcd' as Hex
    },
    simulate: async () => ({ status: overrides.simulates?.(last!) ?? 'ok', reason: 'nope' }),
    feesFor: async () => FREE_FEES,
    nativeToken: NATIVE,
    validForMs: 4_000,
    now: () => 1_000,
    stats,
    logger,
    ...overrides
  }
  return { deps, stats, lines, attempted }
}

describe('preparing a Midnight liquidation', () => {
  it('answers with the first alternative that quotes and simulates, as a call to the Executor', async () => {
    const { deps, stats, attempted } = harness()
    const answer = await preparePosition(request(), pricingFor(), deps)
    expect(answer).toStrictEqual({
      ok: true,
      validUntil: 5_000,
      steps: [{ kind: 'tx', payload: { kind: 'tx', to: EXECUTOR, data: '0xabcd', value: 0n } }]
    })
    expect(attempted).toStrictEqual([0])
    expect(stats.flush()).toMatchObject({ candidates: 2, ok: 1, firmCalls: 1, unpriced: 0 })
  })

  it('tries the loan-token slot first once the swap slot is charged its route cost', async () => {
    const { deps, attempted, lines } = harness()
    await preparePosition(request(), pricingFor({ bps: 5_000 }), deps)
    expect(attempted).toStrictEqual([1])
    expect(lines.find(line => line.event === 'plan.built')?.fields).toMatchObject({
      rank: 1,
      collateralIndex: 1,
      routeCostBps: 0
    })
  })

  it('falls through to the next alternative when the first fails to quote', async () => {
    let quotes = 0
    const { deps, attempted } = harness({
      quotes: (): QuoteOutcome =>
        quotes++ === 0 ? { kind: 'failed', reason: 'api_error' } : { kind: 'swap', plan: swap }
    })
    const answer = await preparePosition(request(), pricingFor(), deps)
    expect(answer.ok).toBe(true)
    expect(quotes).toBe(2)
    expect(attempted).toHaveLength(1)
  })

  it.each([
    [
      'a failed quote',
      { quotes: () => ({ kind: 'failed', reason: 'api_error' }) as const },
      'failed',
      true
    ],
    [
      'a route short of its repay',
      { quotes: () => ({ kind: 'failed', reason: 'floor_unmet' }) as const },
      'unprofitable',
      false
    ],
    ['no route', { quotes: () => ({ kind: 'no_config' }) as const }, 'no_swap_path', false],
    ['a reverted simulation', { simulates: () => 'revert' as const }, 'failed', true]
  ])('declines on %s, backing off only on a failure', async (_, overrides, reason, backoff) => {
    const { deps } = harness(overrides)
    expect(await preparePosition(request([0]), pricingFor(), deps)).toStrictEqual({
      ok: false,
      reason,
      backoff
    })
  })

  it('declines a route short of the repay before simulating it, without backing off', async () => {
    let simulated = 0
    const { deps, attempted, lines } = harness({
      quotes: plan => ({
        kind: 'swap',
        plan: { ...swap, expectedAmountOut: plan.impliedRepaidUnits - 1n },
        firmCalls: 1
      }),
      simulate: async () => {
        simulated += 1
        return { status: 'ok' }
      }
    })
    expect(await preparePosition(request([0]), pricingFor(), deps)).toStrictEqual({
      ok: false,
      reason: 'unprofitable',
      backoff: false
    })
    expect(simulated).toBe(0)
    expect(attempted).toStrictEqual([])
    const unprofitable = lines.find(line => line.event === 'quote.unprofitable')?.fields
    const repay = unprofitable?.requiredRepay as bigint
    expect(unprofitable).toMatchObject({
      collateralIndex: 0,
      requiredThreshold: repay,
      achievableOut: repay - 1n,
      shortfallBps: 0n,
      minSurplusBps: 0
    })
  })

  describe('with the native token priced', () => {
    /** $3 of a $1 loan token at $2,000 per native token. */
    const PROFIT = 3n * 10n ** 18n
    const PROFIT_WEI = 15n * 10n ** 14n
    const priced = () => ({
      ...pricingFor(),
      prices: readingsOf({ ...PRICES, [NATIVE]: { priceE8: 2_000n * 10n ** 8n, decimals: 18 } })
    })
    const profitable = (execution: bigint, l1Data = 0n) =>
      harness({
        quotes: plan => ({
          kind: 'swap',
          plan: { ...swap, expectedAmountOut: plan.impliedRepaidUnits + PROFIT }
        }),
        feesFor: async () => feesNeeding(execution, l1Data)
      })

    it('caps the fees of the liquidation it sends at its expected profit, less its L1 data fee', async () => {
      const { deps } = profitable(PROFIT_WEI - 7n, 7n)
      expect(await preparePosition(request([0]), priced(), deps)).toMatchObject({
        ok: true,
        maxSpendWei: PROFIT_WEI - 7n
      })
    })

    it('backs off a liquidation whose profit cannot fund a first bid at the base fee', async () => {
      const { deps, stats } = profitable(PROFIT_WEI - 6n, 7n)
      expect(await preparePosition(request([0]), priced(), deps)).toStrictEqual({
        ok: false,
        reason: 'gas_unaffordable',
        backoff: true
      })
      expect(stats.flush()).toMatchObject({ ok: 1, gasUnaffordable: 1 })
    })

    it('backs off a liquidation whose capped first bid is priced under the base fee', async () => {
      const [estimatedGas, baseFee] = [25_000n, parseGwei('60')]
      const { deps } = harness({
        quotes: plan => ({
          kind: 'swap',
          plan: { ...swap, expectedAmountOut: plan.impliedRepaidUnits + PROFIT }
        }),
        feesFor: async () => ({
          l1Data: 0n,
          baseFee,
          gasLimit: 30_000n,
          firstBid: fee =>
            firstBid({
              fee,
              estimatedGas,
              baseFee,
              maxFeePerGas: parseGwei('50'),
              gasLimit: 30_000n
            })
        })
      })
      expect(await preparePosition(request([0]), priced(), deps)).toStrictEqual({
        ok: false,
        reason: 'gas_unaffordable',
        backoff: true
      })
    })

    it('holds a ramping liquidation its profit cannot fund yet only to the next head', async () => {
      const matured = request([0])
      const out = outAt(unhealthy(0, 1, [0]), 5_000n, 100n)
      const { deps, stats } = profitable(PROFIT_WEI + 1n)
      expect(
        await preparePosition({ ...matured, input: { ...matured.input, out } }, priced(), deps)
      ).toStrictEqual({ ok: false, reason: 'unprofitable', backoff: false })
      expect(stats.flush()).toMatchObject({ gasUnaffordable: 2 })
    })

    it('falls through to an alternative whose profit covers its gas', async () => {
      const { deps, attempted } = harness({
        quotes: plan => ({
          kind: 'swap',
          plan: { ...swap, expectedAmountOut: plan.impliedRepaidUnits + PROFIT }
        }),
        feesFor: async () => feesNeeding(attempted.length === 1 ? PROFIT_WEI + 1n : 0n)
      })
      const answer = await preparePosition(request(), priced(), deps)
      expect(answer.ok).toBe(true)
      expect(attempted).toHaveLength(2)
    })
  })

  it.each([
    ['priced', pricingFor()],
    ['unpriced', { ...pricingFor(), prices: {} }]
  ])('quotes no alternative whose oracle surplus rounds to nothing, %s', async (_, pricing) => {
    const dust = request([0])
    const { out } = dust.input
    const collaterals = out.collaterals.map(collateral => ({ ...collateral, amt: 1n }))
    let quotes = 0
    const { deps, stats } = harness({
      quotes: () => {
        quotes += 1
        return { kind: 'swap', plan: swap }
      }
    })
    expect(
      await preparePosition(
        { ...dust, input: { ...dust.input, out: { ...out, collaterals } } },
        pricing,
        deps
      )
    ).toMatchObject({ ok: false, reason: 'no_surplus' })
    expect(quotes).toBe(0)
    expect(stats.flush()).toMatchObject({ noSurplus: 1 })
  })

  it.each([
    ['exactly the surplus threshold', 0n, true],
    ['one unit under the surplus threshold', -1n, false]
  ])('holds a route to the minimum surplus: %s', async (_, offset, viable) => {
    const minSurplusBps = 100
    const { deps, lines } = harness({
      minSurplusBps,
      quotes: plan => {
        const repay = plan.impliedRepaidUnits
        const threshold = repay + (repay * 100n + 9_999n) / 10_000n
        return { kind: 'swap', plan: { ...swap, expectedAmountOut: threshold + offset } }
      }
    })
    const answer = await preparePosition(request([0]), pricingFor(), deps)
    expect(answer.ok).toBe(viable)
    const unprofitable = lines.find(line => line.event === 'quote.unprofitable')?.fields
    if (viable) expect(unprofitable).toBeUndefined()
    else
      expect(unprofitable).toMatchObject({
        minSurplusBps,
        achievableOut: (unprofitable?.requiredThreshold as bigint) - 1n
      })
  })

  it('lets an alternative short of its ramping incentive keep its position from backing off', async () => {
    const { deps } = harness({
      quotes: (plan): QuoteOutcome =>
        plan.collateralIndex === 0
          ? { kind: 'failed', reason: 'api_error' }
          : { kind: 'failed', reason: 'floor_unmet' }
    })
    expect(await preparePosition(request(), pricingFor(), deps)).toMatchObject({
      ok: false,
      reason: 'unprofitable',
      backoff: false
    })
  })

  it('stops after two attempts once every alternative is costed', async () => {
    const matured = request()
    const out = { ...outAt(unhealthy(0, 1, [0, 1]), 5_000n, 100n) }
    let quotes = 0
    const { deps, lines } = harness({
      quotes: (): QuoteOutcome => {
        quotes += 1
        return { kind: 'failed', reason: 'api_error' }
      }
    })
    const answer = await preparePosition(
      { ...matured, input: { ...matured.input, out } },
      pricingFor({ bps: 0 }),
      deps
    )
    expect(answer).toMatchObject({ ok: false, reason: 'failed', backoff: true })
    expect(quotes).toBe(2)
    expect(
      lines.filter(
        line => line.event === 'preselect.skipped' && line.fields.reason === 'fall_through_bound'
      )
    ).toHaveLength(2)
  })

  it('simulates a write-off without quoting it, and never backs one off', async () => {
    const writeOff = request([0])
    const out = { ...writeOff.input.out, maxDebt: 0n, badDebt: writeOff.input.out.debt }
    let quotes = 0
    const { deps } = harness({
      quotes: () => {
        quotes += 1
        return { kind: 'swap', plan: swap }
      },
      simulates: () => 'revert'
    })
    expect(
      await preparePosition({ ...writeOff, input: { ...writeOff.input, out } }, pricingFor(), deps)
    ).toMatchObject({ ok: false, reason: 'reverted', backoff: false })
    expect(quotes).toBe(0)
  })

  it('declines a position sizing cannot plan, without backing off', async () => {
    const { deps } = harness()
    expect(await preparePosition(request([]), pricingFor(), deps)).toMatchObject({
      ok: false,
      reason: 'no_plan',
      backoff: false
    })
  })

  it('reads a price past its expiry as unpriced, and logs what expired', async () => {
    const { deps, stats, lines } = harness({ now: () => 2_000 })
    const pricing = pricingFor({ bps: 100 })
    await preparePosition(request([0]), { ...pricing, prices: readingsOf(PRICES, 2_000) }, deps)
    expect(stats.flush()).toMatchObject({ candidates: 1, unpriced: 1 })
    expect(lines.filter(line => line.event === 'pricing.expired')).toMatchObject([
      { fields: { id: 'k', prices: 1, routes: 0, curves: 0 } }
    ])
  })

  it('orders an unpriced loan token last and counts it', async () => {
    const { deps, stats } = harness()
    await preparePosition(request([0]), { ...pricingFor(), prices: {} }, deps)
    expect(stats.flush()).toMatchObject({ candidates: 1, unpriced: 1 })
  })
})
