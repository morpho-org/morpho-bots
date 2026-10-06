import type { PlanSkipReason } from '../sizing/plan'

/**
 * How long an unchanged `plan.skipped` stays quiet before it is emitted again. Long enough that a
 * permanently unsizeable dust position costs a handful of lines per hour rather than one per block,
 * short enough that BetterStack's ~1 h live window always holds at least one line for it.
 */
const PLAN_SKIP_RELOG_MS = 10 * 60_000

type SkipIdentity = {
  label: string
  collateralIndex: number
  /** Absent for a skip that precedes mode selection. */
  postMaturityMode: boolean | undefined
  reason: PlanSkipReason
}

/**
 * Deduplicates `plan.skipped` across ticks. Volume only: sizing and `tick.end` counters are unchanged,
 * and a tick never suppresses a skip the previous tick did not also report.
 */
export type PlanSkipLog = {
  shouldLog: (skip: SkipIdentity) => boolean
  /** Ends a tick, forgetting every skip it did not report, so one that returns logs at once. */
  sweep: () => void
}

export const createPlanSkipLog = (
  opts: { relogMs?: number; now?: () => number } = {}
): PlanSkipLog => {
  const relogMs = opts.relogMs ?? PLAN_SKIP_RELOG_MS
  const now = opts.now ?? (() => Date.now())
  const loggedAt = new Map<string, number>()
  const seen = new Set<string>()

  return {
    shouldLog: ({ label, collateralIndex, postMaturityMode, reason }) => {
      const key = `${label}:${collateralIndex}:${postMaturityMode ?? '-'}:${reason}`
      seen.add(key)
      const at = now()
      const last = loggedAt.get(key)
      if (last !== undefined && at - last < relogMs) return false
      loggedAt.set(key, at)
      return true
    },
    sweep: () => {
      for (const key of loggedAt.keys()) {
        if (!seen.has(key)) loggedAt.delete(key)
      }
      seen.clear()
    }
  }
}
