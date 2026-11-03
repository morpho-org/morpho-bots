import type { Backoff, KernelView } from '@repo/controller'
import type { Keyed } from '@repo/engine'
import type { Logger } from '@repo/kit'

import { isBackedOff, isBusy, pendingFields } from '@repo/controller'
import { createTxReporter } from '@repo/kit'

import type { PositionReading, Sizing } from './liquidation'
import type { PlanSkipLog } from './runner/plan-skip-log'
import type { PlanSkipReason } from './sizing/plan'
import type { TickStats } from './stats'

import { taskOf } from './liquidation'

/**
 * `warn` marks a reason that negates liquidatability, so the line reads as a live assertion. A
 * reason that fires identically for every candidate in a group is `debug`: headroom is a rate, the
 * same for every position sharing a maturity, LIF and mode.
 */
const LEVEL_BY_REASON: Record<PlanSkipReason, 'debug' | 'info' | 'warn'> = {
  no_debt: 'warn',
  locked: 'warn',
  healthy_pre_maturity: 'warn',
  cap_not_positive: 'info',
  nothing_to_seize: 'info',
  seize_rounds_to_zero: 'info',
  writeoff_below_max_debt: 'info',
  insufficient_headroom: 'debug'
}

/** What one world read left the graph holding, read once the read has propagated. */
type WorldState = Readonly<{
  positions?: Keyed<PositionReading>
  liquidatable?: Keyed<unknown>
  sizing?: Keyed<Sizing>
  view?: KernelView
  backoff?: Backoff
  /** Whether the read vouched for its whole scope. */
  complete: boolean
}>

/**
 * Where each position whose fact holds stands: in flight, without a plan, planned, or backed off
 * for the task its sizing wants. Every position not in flight is `idle`, with the sizing whose skips
 * it reports.
 */
export const classifyWorld = ({
  sizing,
  liquidatable,
  view,
  backoff
}: Omit<WorldState, 'positions' | 'complete'>) => {
  const counts = {
    liquidatable: 0,
    inflightSkipped: 0,
    planSkipped: 0,
    planned: 0,
    backoffSkipped: 0
  }
  const idle: { key: string; sizing: Sizing }[] = []
  for (const [key, fact] of Object.entries(sizing?.keys ?? {})) {
    if (fact.status !== 'present' || liquidatable?.keys[key]?.status !== 'present') continue
    counts.liquidatable += 1
    if (isBusy(view, key)) {
      counts.inflightSkipped += 1
      continue
    }
    idle.push({ key, sizing: fact.value })
    if (fact.value.plans.length === 0) {
      counts.planSkipped += 1
      continue
    }
    counts.planned += 1
    if (isBackedOff(backoff, key, taskOf(fact.value))) counts.backoffSkipped += 1
  }
  return { ...counts, idle }
}

/**
 * The bot's operator log. Per world read, `plan.skipped` for each alternative sizing could not
 * size, deduplicated by `planSkipLog`, and `tick.end`; per kernel transaction, the
 * {@link createTxReporter} events and `liquidation.not_sent`.
 */
export const createReporter = (deps: {
  stats: TickStats
  planSkipLog: PlanSkipLog
  headroomFloorBps: number
  logger: Logger
}) => {
  const { stats, logger } = deps

  const reportSkips = (key: string, sizing: Sizing, reading: PositionReading | undefined) => {
    for (const { reason, collateralIndex, postMaturityMode, headroom } of sizing.skips) {
      if (!deps.planSkipLog.shouldLog({ label: key, collateralIndex, postMaturityMode, reason }))
        continue
      logger[LEVEL_BY_REASON[reason]]('plan.skipped', {
        id: key,
        marketId: reading?.marketId,
        borrower: reading?.borrower,
        collateralIndex,
        reason,
        ...(headroom && {
          headroomBps: headroom.bps,
          headroomFloorBps: deps.headroomFloorBps,
          lif: headroom.lif,
          postMaturityMode: headroom.postMaturityMode,
          ...(reading && {
            secondsSinceMaturity: reading.out.blockTimestamp - reading.out.market.maturity
          })
        })
      })
    }
  }

  const reportWorld = ({ positions, complete, ...world }: WorldState) => {
    const { idle, ...counts } = classifyWorld(world)
    for (const { key, sizing } of idle) {
      const reading = positions?.keys[key]
      reportSkips(key, sizing, reading?.status === 'present' ? reading.value : undefined)
    }
    deps.planSkipLog.sweep()
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
