import type { FailureCounts } from '../../domain/market-failure-budget'
import type { ValidBootstrapConfig } from '../../domain/position-bootstrap'
import type { Verdict } from './decision'
import type { MarketReport, Workflow } from './market-report'
import type { BootstrapReading } from './readings'

import {
  countFailures,
  exhausted,
  MARKET_FAILURE_BUDGET_CYCLES
} from '../../domain/market-failure-budget'
import { decidePositionBootstrapTransition } from '../../domain/position-bootstrap'

/** What the failure budget reads of one market's report. */
export type CycleReport = Readonly<
  Pick<MarketReport, 'workflow' | 'marketId' | 'status'> & Pick<MarketReport, 'stage' | 'action'>
>

/**
 * One completed markets poll: each market not in flight, counted with the outcome of an act that
 * ended since the last poll, else its decision; and the bootstrap markets whose decision this poll
 * reached the initial target, in flight or not.
 */
export type Cycle = Readonly<{
  counted: readonly CycleReport[]
  completed: readonly string[]
}>

const BOOTSTRAP_CLEARS = new Set([
  'no-capacity',
  'rate-out-of-range',
  'auto-refill-disabled',
  'target-reached'
])

/** Whether a report leaves its market's last failed act unresolved, as the monitors counted it. */
const unresolvedAfter = (report: CycleReport): boolean | undefined => {
  const { action, status } = report
  if (status === 'failed' && report.stage === 'act') return true
  if (status === 'applied' || status === 'logged' || action === 'lend-halted') return false
  if (report.workflow === 'ladder') {
    if (status === 'failed' && report.stage === 'reconcile') return true
    return action === 'publication-withdrawn' ? false : undefined
  }
  if (
    action === 'publication-withheld' ||
    (status === 'observed' && action !== undefined && BOOTSTRAP_CLEARS.has(action))
  )
    return false
  return undefined
}

type WorkflowBudget = Readonly<{ counts: FailureCounts; unresolved: readonly string[] }>

/** Each workflow's failure counts, and the workflows whose budget ran out, which stay out. */
export type FailureBudget = Readonly<{
  ladder: WorkflowBudget
  bootstrap: WorkflowBudget
  exhausted: readonly Workflow[]
}>

export const EMPTY_BUDGET: FailureBudget = {
  ladder: { counts: {}, unresolved: [] },
  bootstrap: { counts: {}, unresolved: [] },
  exhausted: []
}

/**
 * Counts one cycle into each workflow's budget: five consecutive failing polls of one market.
 * @param budget - The budget before this cycle.
 * @param cycle - The completed poll to count.
 * @returns The next budget; an exhausted workflow stays exhausted.
 */
export const foldBudget = (budget: FailureBudget, cycle: Cycle): FailureBudget => {
  const next = (workflow: Workflow): WorkflowBudget => {
    const polled = cycle.counted.filter(report => report.workflow === workflow)
    const unresolved = new Set(budget[workflow].unresolved)
    for (const report of polled) {
      const after = unresolvedAfter(report)
      if (after === true) unresolved.add(report.marketId)
      if (after === false) unresolved.delete(report.marketId)
    }
    return {
      counts: countFailures(budget[workflow].counts, polled, unresolved),
      unresolved: [...unresolved].toSorted()
    }
  }
  const ladder = next('ladder')
  const bootstrap = next('bootstrap')
  const spent = (['ladder', 'bootstrap'] as const).filter(
    workflow =>
      budget.exhausted.includes(workflow) ||
      exhausted({ ladder, bootstrap }[workflow].counts, MARKET_FAILURE_BUDGET_CYCLES)
  )
  return { ladder, bootstrap, exhausted: spent }
}

/**
 * Halts with the workflows whose budget ran out.
 * @param budget - The folded failure budget.
 * @returns `ok` while no workflow is exhausted, else a halt naming the exhausted workflows.
 */
export const budgetVerdict = (budget: FailureBudget): Verdict =>
  budget.exhausted.length > 0 ? { ok: false, halt: budget.exhausted.join(',') } : { ok: true }

/**
 * Adds the markets that reached their initial target this cycle; a market never leaves.
 * @param completed - Market ids that reached their target in earlier cycles.
 * @param cycle - The poll just completed.
 * @returns The sorted union, or `completed` itself when nothing new completed.
 */
export const foldCompleted = (completed: readonly string[], cycle: Cycle): readonly string[] =>
  cycle.completed.every(marketId => completed.includes(marketId))
    ? completed
    : [...new Set([...completed, ...cycle.completed])].toSorted()

/**
 * Whether a bootstrap reading reaches the initial target, by the same validated transition the
 * decision takes; it reads only the position, so a decision failing for another reason cannot hide
 * an observed completion.
 * @param reading - The bootstrap market's reading from one poll.
 * @param config - The market's validated bootstrap config.
 * @returns `true` only when the position read succeeded and its transition completes the target.
 */
export const reachesInitialTarget = (
  reading: BootstrapReading,
  config: ValidBootstrapConfig
): boolean => {
  if (!reading.position.ok) return false
  const position = reading.position.value
  try {
    const transition = decidePositionBootstrapTransition({
      config,
      position,
      lossFactor: position.lossFactor,
      ...(position.activeOffer ? { activeOffer: position.activeOffer } : {}),
      initialTargetCompleted: reading.initialTargetCompleted
    })
    return transition !== undefined && 'completesInitialTarget' in transition
      ? transition.completesInitialTarget
      : false
  } catch {
    return false
  }
}
