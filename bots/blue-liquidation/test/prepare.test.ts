import type { PrepareRequest } from '@repo/controller'
import type { Logger } from '@repo/kit'
import type { SwapPlan } from '@repo/swaps'
import type { Hex } from 'viem'

import { describe, expect, it } from 'vitest'

import type { PrepareDeps, QuotedPosition } from '../src/prepare'
import type { LensOut } from '../src/state/lens.sol'

import { sizePosition } from '../src/liquidation'
import { preparePosition } from '../src/prepare'
import { createTickStats } from '../src/stats'
import { borrowerAt, EXECUTOR, market, MARKET_ID } from './scenario/bot'

const BORROWER = borrowerAt(1)

const unhealthy: LensOut = {
  valid: true,
  hasDebt: true,
  healthy: false,
  blockTimestamp: 1n,
  borrowShares: 10n ** 24n,
  collateral: 10n ** 18n,
  accruedTotalBorrowAssets: 10n ** 18n,
  totalBorrowShares: 10n ** 24n,
  collateralPrice: 10n ** 36n,
  lltv: market.lltv,
  params: market
}

const swap: SwapPlan = { steps: [], expectedAmountOut: 10n ** 18n, amountOutMinimum: 1n }
const SEIZE = sizePosition(unhealthy).plan!.seizedAssets

const request = (
  out: LensOut = unhealthy,
  seizedAssets = SEIZE
): PrepareRequest<QuotedPosition> => ({
  id: 'run.p0',
  key: 'k',
  task: 'liquidate',
  version: 'v',
  seq: 0,
  input: {
    reading: { marketId: MARKET_ID, borrower: BORROWER, out, block: 41 },
    quote: { kind: 'route', seizedAssets, swap }
  }
})

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const deps = (overrides: Partial<PrepareDeps> = {}) => {
  const stats = createTickStats()
  return {
    stats,
    deps: {
      executor: EXECUTOR,
      encode: () => '0xabcd' as Hex,
      simulate: async () => ({ status: 'ok' }),
      stats,
      logger: silent,
      ...overrides
    } satisfies PrepareDeps
  }
}

describe('preparing a liquidation', () => {
  it('answers the simulated calldata as one Executor call, seizing what its route sells', async () => {
    const encoded: unknown[][] = []
    const simulated: Hex[] = []
    const { deps: d, stats } = deps({
      encode: (...args) => {
        encoded.push(args)
        return '0xabcd'
      },
      simulate: async data => {
        simulated.push(data)
        return { status: 'ok' }
      }
    })
    expect(await preparePosition(request(unhealthy, SEIZE - 1n), d)).toStrictEqual({
      ok: true,
      steps: [{ kind: 'tx', payload: { kind: 'tx', to: EXECUTOR, data: '0xabcd', value: 0n } }]
    })
    expect(stats.flush()).toMatchObject({ ok: 1 })
    expect(encoded).toStrictEqual([[market, BORROWER, SEIZE - 1n, swap]])
    expect(simulated).toStrictEqual(['0xabcd'])
  })

  it('backs the position off after a reverted simulation', async () => {
    const { deps: d } = deps({
      simulate: async () => ({ status: 'revert' as const, reason: 'nope' })
    })
    expect(await preparePosition(request(), d)).toMatchObject({
      ok: false,
      reason: 'reverted',
      backoff: true
    })
  })

  it('declines, without backing off, a route selling more than the position gives, or no plan', async () => {
    const { deps: d } = deps()
    expect(await preparePosition(request(unhealthy, SEIZE + 1n), d)).toMatchObject({
      reason: 'quote_oversized',
      backoff: false
    })
    expect(await preparePosition(request({ ...unhealthy, collateral: 0n }), d)).toMatchObject({
      reason: 'no_plan',
      backoff: false
    })
  })
})
