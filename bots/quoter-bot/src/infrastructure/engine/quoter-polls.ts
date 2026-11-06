import type { Keyed } from '@repo/engine'
import type { Hex } from 'viem'

import { keyRecord } from '@repo/engine'

import type { MarketReport, Workflow } from '../../application/engine/market-report'
import type { ActEvent, Decided } from './quoter-acts'

import { outcomeReport, unavailableReport } from '../../application/engine/market-report'

/**
 * What the quoter reports: each poll's decisions and the markets it counts, each market not in
 * flight with the outcome of an act that ended since the last poll, else its decision; each act's
 * outcome as it ends; and the markets' current decisions whenever one changes between polls. A poll
 * leaves out each market not in flight that awaits its preparation, which a later `poll` reports
 * once its decision is made; a market in flight may still report `preparing`. A preparation that
 * outlives its deadline is reported and counted as a failed `prepare` when it times out.
 */
export type QuoterReport =
  | Readonly<{
      type: 'poll'
      decided: readonly MarketReport[]
      counted: readonly MarketReport[]
      completed: readonly Hex[]
    }>
  | Readonly<{ type: 'outcome'; key: string; report: MarketReport; settled: boolean }>
  | Readonly<{ type: 'decided'; decided: readonly MarketReport[] }>

/** What the polls remember between steps: the inputs last seen, and each market's acts. */
export type Polls = Readonly<{
  decisions: Keyed<Decided> | undefined
  /** The digest of the world read last seen, and of the one last polled. */
  world: string | undefined
  polled: string | undefined
  inFlight: Readonly<Record<string, true>>
  ended: Readonly<Record<string, MarketReport>>
  /** The markets awaiting their preparation since the last poll, each with whether to count it. */
  deferred: Readonly<Record<string, boolean>>
  /** A dry run's condition per market in flight, which its outcome reports. */
  conditions: Readonly<Record<string, string>>
}>

export const NO_POLLS: Polls = {
  decisions: undefined,
  world: undefined,
  polled: undefined,
  inFlight: {},
  ended: {},
  deferred: {},
  conditions: {}
}

type Reported = Readonly<{ state: Polls; report?: QuoterReport }>

const workflowOf = (key: string) => key.split(':') as [Workflow, Hex]

/** The action of a decision whose preparation has not answered for its read. */
const PREPARING = 'preparing'

/** A market whose preparation outlived its deadline. */
const preparationTimedOut = (key: string): MarketReport => {
  const [workflow, marketId] = workflowOf(key)
  return { workflow, marketId, status: 'failed', stage: 'prepare', errorName: 'TimeoutError' }
}

/** A market's current decision report, or its reading unavailable when it has none. */
const decisionReport = (decided: Keyed<Decided> | undefined, key: string): MarketReport => {
  const [workflow, marketId] = workflowOf(key)
  const fact = decided === undefined ? undefined : keyRecord(decided, key)
  if (decided?.coverage.status === 'complete' && fact?.status === 'present')
    return fact.value.decision.detail
  return unavailableReport(
    workflow,
    marketId,
    decided?.coverage.reason ?? 'QuoterReadingUnavailableError'
  )
}

/**
 * The quoter's reports over its markets, `keys`, as pure transitions: a dry run reports an act's
 * outcome as logged, with the condition it would have signed.
 * @param keys - Controller keys of the run's markets, in report order.
 * @param dry - Whether the run signs and sends nothing.
 * @returns The poll transitions, each returning the next state and any report.
 */
export const createPolls = (keys: readonly string[], dry: boolean) => ({
  /** Records the latest decisions and reports each market's current decision. */
  decided: (state: Polls, decisions: Keyed<Decided> | undefined): Reported => ({
    state: { ...state, decisions },
    report: { type: 'decided', decided: keys.map(key => decisionReport(decisions, key)) }
  }),

  /** Reports and counts a preparation that outlived its deadline. */
  timedOut: (state: Polls, key: string): Reported => {
    const report = preparationTimedOut(key)
    return {
      state,
      report: {
        type: 'poll',
        decided: [report],
        counted: state.inFlight[key] ? [] : [report],
        completed: []
      }
    }
  },

  /** Records the digest of the latest world read; reports nothing. */
  read: (state: Polls, world: string | undefined): Reported => ({ state: { ...state, world } }),

  /** Tracks an act in flight, and reports its outcome once it ends. */
  event: (state: Polls, event: ActEvent): Reported => {
    if (event.type === 'steady') return { state }
    if (event.type === 'submitted')
      return {
        state: {
          ...state,
          inFlight: { ...state.inFlight, [event.key]: true },
          conditions: dry
            ? { ...state.conditions, [event.key]: event.act.condition }
            : state.conditions
        }
      }
    const [workflow, marketId] = workflowOf(event.key)
    const condition = state.conditions[event.key]
    const report: MarketReport = {
      ...outcomeReport(
        event.outcome,
        { workflow, marketId, dry },
        decisionReport(state.decisions, event.key)
      ),
      ...(condition === undefined ? {} : { condition })
    }
    const { [event.key]: _, ...inFlight } = state.inFlight
    return {
      state: { ...state, inFlight, ended: { ...state.ended, [event.key]: report } },
      report: {
        type: 'outcome',
        key: event.key,
        report,
        settled: event.outcome.notice === 'settled'
      }
    }
  },

  /**
   * Once per world read: the poll that counts each market not in flight, deferring one awaiting its
   * preparation; then, until the next read, a poll of each deferred market once its decision is
   * made, counted unless its read's poll already counted an outcome for it.
   */
  settle: (state: Polls): Reported => {
    if (state.world === undefined) return { state }
    const reports = keys.map(key => decisionReport(state.decisions, key))
    const awaiting = (key: string, i: number) =>
      !state.inFlight[key] && reports[i]!.action === PREPARING
    if (state.world === state.polled) {
      const deferred = { ...state.deferred }
      keys.forEach((key, i) => {
        if (!(key in deferred) && awaiting(key, i)) deferred[key] = false
      })
      const made = keys.flatMap((key, i) =>
        key in deferred && reports[i]!.action !== PREPARING ? [i] : []
      )
      for (const i of made) delete deferred[keys[i]!]
      if (made.length === 0)
        return Object.keys(deferred).length === Object.keys(state.deferred).length
          ? { state }
          : { state: { ...state, deferred } }
      return {
        state: { ...state, deferred },
        report: {
          type: 'poll',
          decided: made.map(i => reports[i]!),
          counted: made.flatMap(i =>
            state.deferred[keys[i]!] && !state.inFlight[keys[i]!] ? [reports[i]!] : []
          ),
          completed: []
        }
      }
    }
    const deferred: Record<string, boolean> = {}
    keys.forEach((key, i) => {
      if (awaiting(key, i)) deferred[key] = !(key in state.ended)
    })
    const decided = reports.filter((_, i) => !(keys[i]! in deferred))
    const counted = keys.flatMap((key, i) =>
      state.inFlight[key] || deferred[key] ? [] : [state.ended[key] ?? reports[i]!]
    )
    const ended = Object.fromEntries(
      Object.entries(state.ended).filter(([key]) => state.inFlight[key])
    )
    const completed = keys.flatMap(key => {
      const fact = state.decisions && keyRecord(state.decisions, key)
      return fact?.status === 'present' && fact.value.completes ? [workflowOf(key)[1]] : []
    })
    return {
      state: { ...state, polled: state.world, ended, deferred },
      report: { type: 'poll', decided, counted, completed }
    }
  }
})
