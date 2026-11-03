import type { PrepareOutcome, PrepareRequest } from '@repo/controller'
import type { Logger, SimulateResult } from '@repo/kit'
import type { SwapPlan } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { tryCatch } from '@repo/utils'

import type { PositionReading } from './liquidation'
import type { MarketParams } from './market'
import type { RouteQuote } from './sources'
import type { TickStats } from './stats'

import { sizePosition } from './liquidation'
import { revertReason } from './revert.utils'

/** A position as the world read it, beside the route its quote fact holds. */
export type QuotedPosition = Readonly<{ reading: PositionReading; quote: RouteQuote }>

export type PrepareDeps = Readonly<{
  executor: Address
  encode: (market: MarketParams, borrower: Address, seizedAssets: bigint, swap: SwapPlan) => Hex
  simulate: (data: Hex) => Promise<SimulateResult>
  stats: TickStats
  logger: Logger
}>

/**
 * Prepares one position from its reading and quote: encodes a liquidation seizing exactly what the
 * route sells, and simulates it. A route that sells more than the position can now give declines
 * until it is quoted again; a reverted simulation backs the position off.
 */
export const preparePosition = async (
  request: PrepareRequest<QuotedPosition>,
  deps: PrepareDeps
): Promise<PrepareOutcome> => {
  const { reading, quote } = request.input
  const { marketId, borrower, out } = reading
  const fields = { id: request.key, marketId, borrower }
  const skip = (reason: string, backoff: boolean): PrepareOutcome => ({
    ok: false,
    reason,
    backoff
  })
  const { plan } = sizePosition(out)
  if (!plan) return skip('no_plan', false)
  if (quote.seizedAssets > plan.seizedAssets) return skip('quote_oversized', false)
  deps.logger.info('plan.built', { ...fields, seizedAssets: quote.seizedAssets })
  const data = deps.encode(out.params, borrower, quote.seizedAssets, quote.swap)
  const result = await deps.simulate(data)
  if (result.status !== 'ok') {
    deps.stats.add({ reverted: 1 })
    deps.logger.warn('simulate.revert', { ...fields, reason: result.reason })
    return skip('reverted', true)
  }
  deps.stats.add({ ok: 1 })
  deps.logger.info('simulate.ok', fields)
  return {
    ok: true,
    steps: [{ kind: 'tx', payload: { kind: 'tx', to: deps.executor, data, value: 0n } }]
  }
}

/** {@link preparePosition} as the family runs it: a throw is a failure that backs the key off. */
export const createPositionPreparer =
  (deps: PrepareDeps) =>
  async (request: PrepareRequest<QuotedPosition>): Promise<PrepareOutcome> => {
    const answer = await tryCatch(preparePosition(request, deps))
    if (!answer.error) return answer.data
    deps.logger.warn('prepare.error', { id: request.key, reason: revertReason(answer.error) })
    return { ok: false, reason: 'error', backoff: true }
  }
