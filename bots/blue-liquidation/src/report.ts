import type { Backoff, KernelView } from '@repo/controller'
import type { Keyed } from '@repo/engine'
import type { Logger } from '@repo/kit'

import { isBackedOff, isBusy, pendingFields } from '@repo/controller'
import { createTxReporter } from '@repo/kit'

import type { Sizing } from './liquidation'
import type { PlanSkipReason } from './sizing/plan'
import type { TickStats } from './stats'

/**
 * `warn` marks a reason that should not happen, so the line reads as a live assertion: `no_debt` and
 * `healthy` negate liquidatability, and a non-reverting zero oracle price is a market anomaly.
 */
const LEVEL_BY_REASON: Record<PlanSkipReason, 'info' | 'warn'> = {
  no_debt: 'warn',
  healthy: 'warn',
  zero_price: 'warn',
  no_collateral: 'info',
  seize_rounds_to_zero: 'info'
}

/** What one world read left the graph holding, read once the read has propagated. */
type WorldState = Readonly<{
  sizing?: Keyed<Sizing>
  view?: KernelView
  backoff?: Backoff
  /** Whether the read succeeded, so the counters describe a whole read. */
  complete: boolean
}>

/** Where each position a world read holds stands: in flight, skipped with its reason, planned, or backed off. */
export const classifyWorld = ({ sizing, view, backoff }: Omit<WorldState, 'complete'>) => {
  const counts = {
    liquidatable: 0,
    inflightSkipped: 0,
    planSkipped: 0,
    planned: 0,
    backoffSkipped: 0
  }
  const skipped: { key: string; reason: PlanSkipReason }[] = []
  for (const [key, fact] of Object.entries(sizing?.keys ?? {})) {
    if (fact.status !== 'present') continue
    counts.liquidatable += 1
    if (isBusy(view, key)) {
      counts.inflightSkipped += 1
      continue
    }
    const { plan, reason } = fact.value
    if (!plan) {
      counts.planSkipped += 1
      skipped.push({ key, reason })
      continue
    }
    counts.planned += 1
    if (isBackedOff(backoff, key)) counts.backoffSkipped += 1
  }
  return { ...counts, skipped }
}

/**
 * The bot's operator log. Per world read, `plan.skipped` and `tick.end`; per kernel transaction,
 * the {@link createTxReporter} events and `liquidation.not_sent`.
 */
export const createReporter = (deps: { stats: TickStats; logger: Logger }) => {
  const { stats, logger } = deps

  const reportWorld = ({ complete, ...world }: WorldState) => {
    const { skipped, ...counts } = classifyWorld(world)
    for (const { key, reason } of skipped) {
      const [marketId, borrower] = key.split(':')
      logger[LEVEL_BY_REASON[reason]]('plan.skipped', { id: key, marketId, borrower, reason })
    }
    logger.info('tick.end', {
      ...stats.flush(),
      ...counts,
      cooledDown: 0,
      complete,
      ...pendingFields(world.view)
    })
  }

  const reportActivity = createTxReporter({
    logger,
    count: counter => stats.add({ [counter]: 1 }),
    reportNotSent: fields => logger.warn('liquidation.not_sent', fields)
  })

  return { reportWorld, reportActivity }
}
