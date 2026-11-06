import type { Keyed } from '@repo/engine'
import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { FailureBudget } from '../src/application/engine/cycles'
import type { Act, Outcome } from '../src/application/engine/decision'
import type { MarketReport } from '../src/application/engine/market-report'
import type { MonitoringEvent } from '../src/application/monitoring/monitoring-event'
import type { Decided } from '../src/infrastructure/engine/quoter-acts'
import type { Polls, QuoterReport } from '../src/infrastructure/engine/quoter-polls'

import { EMPTY_BUDGET, foldBudget } from '../src/application/engine/cycles'
import { createMarketProjection } from '../src/application/monitoring/market-monitoring.utils'
import { MARKET_FAILURE_BUDGET_CYCLES } from '../src/domain/market-failure-budget'
import { createPolls, NO_POLLS } from '../src/infrastructure/engine/quoter-polls'
import { createQuoterReporter } from '../src/report'

const ladderId: Hex = `0x${'11'.repeat(32)}`
const bootstrapId: Hex = `0x${'22'.repeat(32)}`
const ladderKey = `ladder:${ladderId}`
const bootstrapKey = `bootstrap:${bootstrapId}`
const keys = [bootstrapKey, ladderKey]

const rest = (workflow: 'ladder' | 'bootstrap', marketId: Hex): MarketReport =>
  ({ workflow, marketId, status: 'observed', action: 'rest' }) as MarketReport

const preparing = (workflow: 'ladder' | 'bootstrap', marketId: Hex): MarketReport =>
  ({ workflow, marketId, status: 'observed', action: 'preparing' }) as MarketReport

const act = (condition = 'publish'): Act => ({
  kind: 'replace',
  identity: 'quote',
  payload: {},
  condition
})

const ended = (key: string, notice: Outcome['notice'], payload: object, hashes: string[] = []) => ({
  type: 'ended' as const,
  key,
  outcome: {
    intentId: `${key}#run.0`,
    kind: 'replace' as const,
    notice,
    payload: payload as never,
    transactions: hashes.map((hash, step) => ({ step, hash, block: 1 }))
  }
})

/** The graph's polls and its reporter, driven as world reads, decisions and acts arrive. */
const harness = (
  options: {
    dry?: boolean
    emit?: (event: MonitoringEvent) => void
    onWriteError?: (error: unknown, failed: unknown) => void
  } = {}
) => {
  const events: MonitoringEvent[] = []
  const polls = createPolls(keys, options.dry === true)
  const reporter = createQuoterReporter({
    keys,
    emit: event => {
      options.emit?.(event)
      events.push(event)
    },
    ...(options.onWriteError ? { onWriteError: options.onWriteError } : {})
  })
  const decided = new Map<string, MarketReport>(
    keys.map(key => [
      key,
      rest(key.startsWith('ladder') ? 'ladder' : 'bootstrap', key.split(':')[1] as Hex)
    ])
  )
  const reached = new Set<string>()
  let coverage: Keyed<Decided>['coverage'] = { status: 'complete' }
  let state: Polls = NO_POLLS
  let reads = 0
  const counted: QuoterReport[] = []
  const take = (next: { state: Polls; report?: QuoterReport }) => {
    state = next.state
    if (!next.report) return
    if (next.report.type === 'poll') counted.push(next.report)
    reporter.onReport(next.report)
  }
  const decisions = (): Keyed<Decided> => ({
    coverage,
    keys: Object.fromEntries(
      [...decided].map(([key, detail]) => [
        key,
        {
          status: 'present',
          value: {
            decision: { keep: [], steady: true, detail },
            completes: reached.has(key)
          },
          digest: key,
          basis: { block: 1 }
        }
      ])
    )
  })
  const decide = (key: string, report: MarketReport) => {
    decided.set(key, report)
    take(polls.decided(state, decisions()))
  }
  take(polls.decided(state, decisions()))
  const poll = () => {
    const before = events.length
    take(polls.read(state, `read ${++reads}`))
    take(polls.settle(state))
    return events.slice(before)
  }
  const exhausted = () =>
    counted
      .flatMap(report => (report.type === 'poll' ? [report] : []))
      .reduce<FailureBudget>(
        (budget, report) =>
          foldBudget(budget, { counted: report.counted, completed: report.completed }),
        EMPTY_BUDGET
      ).exhausted
  return {
    reporter,
    events,
    counted,
    exhausted,
    poll,
    decide,
    fail: (code: string) => {
      coverage = { status: 'failed', reason: code }
      take(polls.decided(state, decisions()))
    },
    reach: (key: string) => void reached.add(key),
    submit: (key: string, condition?: string) =>
      take(
        polls.event(state, {
          type: 'submitted',
          key,
          intentId: `${key}#run.0`,
          act: act(condition)
        })
      ),
    end: (event: ReturnType<typeof ended>) => take(polls.event(state, event)),
    other: () => take(polls.settle(state)),
    timeOut: (key: string) => take(polls.timedOut(state, key))
  }
}

const completed = (events: readonly MonitoringEvent[]) =>
  events.filter(event => event.event === 'cycle.completed')

describe('the quoter reporter', () => {
  test('reports every market on each world poll, and nothing on other steps', () => {
    const h = harness()

    h.other()
    expect(completed(h.events)).toEqual([])
    expect(completed(h.poll())).toEqual([
      expect.objectContaining({ workflow: 'bootstrap', marketId: bootstrapId, status: 'observed' }),
      expect.objectContaining({ workflow: 'ladder', marketId: ladderId, status: 'observed' })
    ])
  })

  test('reports a market awaiting its preparation once, with the decision its preparation makes', () => {
    const withheld: MarketReport = {
      workflow: 'bootstrap',
      marketId: bootstrapId,
      status: 'observed',
      action: 'publication-withheld',
      reason: 'below-minimum-offer',
      minimumAssets: '100'
    }
    const h = harness()
    for (let read = 0; read < 2; read += 1) {
      h.decide(bootstrapKey, preparing('bootstrap', bootstrapId))
      expect(completed(h.poll())).toEqual([expect.objectContaining({ workflow: 'ladder' })])
      h.decide(bootstrapKey, withheld)
      const before = h.events.length
      h.other()
      expect(h.events.slice(before)).toEqual(createMarketProjection()([withheld]))
      const reported = h.events.length
      h.other()
      expect(h.events).toHaveLength(reported)
    }
  })

  test('reports a preparation asked after its poll, or after an outcome its poll counted, uncounted', () => {
    const h = harness()
    const madeUncounted = (key: string, workflow: 'ladder' | 'bootstrap') => {
      const polls = h.counted.length
      const before = h.events.length
      h.decide(key, rest(workflow, key.split(':')[1] as Hex))
      h.other()
      expect(completed(h.events.slice(before))).toEqual([
        expect.objectContaining({ workflow, action: 'rest' })
      ])
      expect(h.counted.slice(polls)).toEqual([expect.objectContaining({ counted: [] })])
    }
    h.poll()
    h.decide(bootstrapKey, preparing('bootstrap', bootstrapId))
    h.other()
    madeUncounted(bootstrapKey, 'bootstrap')

    h.submit(ladderKey)
    h.end(ended(ladderKey, 'refused', {}))
    h.decide(ladderKey, preparing('ladder', ladderId))
    h.poll()
    madeUncounted(ladderKey, 'ladder')
  })

  test('keeps a market in flight out of the count, then counts its outcome once before its decision', () => {
    const h = harness()
    h.submit(ladderKey)
    h.poll()
    expect(
      (h.counted.at(-1) as Extract<QuoterReport, { type: 'poll' }>).counted.map(r => r.workflow)
    ).toEqual(['bootstrap'])

    const before = h.events.length
    h.end(
      ended(
        ladderKey,
        'settled',
        { cancel: [], report: { status: 'applied', action: 'publish' } },
        ['0x01']
      )
    )
    expect(completed(h.events.slice(before))).toContainEqual(
      expect.objectContaining({ workflow: 'ladder', status: 'applied', action: 'publish' })
    )
    expect(h.events.slice(before)).toContainEqual(
      expect.objectContaining({ event: 'transaction.settled', operation: 'ratify', txHash: '0x01' })
    )
    h.poll()
    expect((h.counted.at(-1) as Extract<QuoterReport, { type: 'poll' }>).counted).toContainEqual(
      expect.objectContaining({ workflow: 'ladder', status: 'applied', action: 'publish' })
    )
    expect(completed(h.poll())).toContainEqual(
      expect.objectContaining({ workflow: 'ladder', status: 'observed', action: 'rest' })
    )
  })

  test('reports a dry run as logged, with the condition it would have signed', () => {
    const h = harness({ dry: true })
    h.submit(ladderKey, 'moved after 2 settled')
    h.end(ended(ladderKey, 'settled', { cancel: [], report: { status: 'applied' } }))

    expect(completed(h.events)).toContainEqual(
      expect.objectContaining({
        workflow: 'ladder',
        status: 'logged',
        condition: 'moved after 2 settled'
      })
    )
  })

  test('reports a failed world read as an unavailable reading', () => {
    const h = harness()
    h.fail('operator_threw')

    expect(completed(h.poll())).toContainEqual({
      event: 'cycle.completed',
      workflow: 'ladder',
      marketId: ladderId,
      status: 'failed',
      stage: 'market-read',
      errorName: 'operator_threw'
    })
  })

  test('records a failed act as it ends, with no poll after it', () => {
    const h = harness()
    h.poll()
    h.submit(ladderKey)
    h.end(ended(ladderKey, 'refused', { cancel: ['a'] }, ['0x01']))

    expect(h.events.slice(-2)).toEqual([
      expect.objectContaining({ event: 'cycle.completed', status: 'failed', stage: 'act' }),
      expect.objectContaining({ event: 'transaction.settled', txHash: '0x01' })
    ])
  })

  test('keeps fill baselines across a poll its market is in flight', () => {
    const consuming = (consumed: bigint): MarketReport => ({
      workflow: 'ladder',
      marketId: ladderId,
      status: 'observed',
      action: 'rest',
      facts: {
        bounds: { minimumRateBps: 0n, maximumRateBps: 1n },
        groupConsumption: [
          {
            groupId: `0x${'33'.repeat(32)}`,
            marketId: ladderId,
            side: 'higher',
            groupRateBps: 500n,
            maxUnits: 1_000n,
            consumed,
            remainingUnits: 1_000n - consumed
          }
        ]
      }
    })
    const h = harness()
    h.decide(ladderKey, consuming(100n))
    h.poll()
    h.submit(ladderKey)
    h.poll()
    h.end(ended(ladderKey, 'refused', {}))
    h.decide(ladderKey, consuming(130n))

    expect(h.poll().filter(event => event.event === 'offer.consumed')).toEqual([
      expect.objectContaining({ consumedDeltaUnits: 30n })
    ])
  })

  test('reports each market final: its last outcome if it acted, else its current decision', () => {
    const h = harness()
    h.poll()
    h.submit(ladderKey)
    h.end(
      ended(ladderKey, 'settled', { cancel: [], report: { status: 'applied', action: 'publish' } })
    )
    h.decide(bootstrapKey, { ...rest('bootstrap', bootstrapId), action: 'target-reached' })

    expect(h.reporter.reports.final()).toEqual([
      {
        workflow: 'bootstrap',
        marketId: bootstrapId,
        status: 'observed',
        action: 'target-reached'
      },
      expect.objectContaining({ workflow: 'ladder', status: 'applied', action: 'publish' })
    ])
    h.poll()
    h.poll()
    expect(h.reporter.reports.final()[1]).toMatchObject({ status: 'applied', action: 'publish' })
  })

  test('reports a market final as failed when a preparation fails after it acted', () => {
    const h = harness()
    const failed = { ...rest('ladder', ladderId), status: 'failed', stage: 'prepare' } as const
    h.poll()
    h.submit(ladderKey)
    h.end(
      ended(ladderKey, 'settled', { cancel: [], report: { status: 'applied', action: 'publish' } })
    )
    h.decide(ladderKey, failed)

    expect(h.reporter.reports.final()[1]).toEqual(failed)
  })

  test('remembers the last poll with a failure until a poll without one', () => {
    const h = harness()
    const failed = { ...rest('ladder', ladderId), status: 'failed', stage: 'market-read' } as const
    h.decide(ladderKey, failed)
    h.poll()
    expect(h.reporter.reports.lastFailed()).toContainEqual(failed)
    h.decide(ladderKey, rest('ladder', ladderId))
    h.poll()
    expect(h.reporter.reports.lastFailed()).toBeUndefined()
  })

  test('keeps a failure while another market’s preparation decides it healthy', () => {
    const h = harness()
    const failed = { ...rest('ladder', ladderId), status: 'failed', stage: 'market-read' } as const
    h.decide(ladderKey, failed)
    h.decide(bootstrapKey, preparing('bootstrap', bootstrapId))
    h.poll()
    h.decide(bootstrapKey, rest('bootstrap', bootstrapId))
    h.other()

    expect(h.reporter.reports.lastFailed()).toContainEqual(failed)
  })

  test('lists the last failed reports in market order, after a deferred market is counted', () => {
    const h = harness()
    const failed = { ...rest('ladder', ladderId), status: 'failed', stage: 'market-read' } as const
    h.decide(ladderKey, failed)
    h.decide(bootstrapKey, preparing('bootstrap', bootstrapId))
    h.poll()
    h.decide(bootstrapKey, rest('bootstrap', bootstrapId))
    h.other()

    expect(h.reporter.reports.lastFailed()).toEqual([rest('bootstrap', bootstrapId), failed])
  })

  test('emits setup readiness and remembers it', () => {
    const h = harness()
    h.reporter.onSetup({ report: { ready: false, checks: [] }, halting: false })

    expect(h.events).toEqual([
      { event: 'cycle.completed', workflow: 'setup-check', status: 'failed' }
    ])
    expect(h.reporter.reports.setupReady()).toBe(false)
  })

  test('counts a failed write, naming the record and its market but never its payload', () => {
    const failures: unknown[] = []
    const h = harness({
      emit: () => {
        throw new Error('writer down')
      },
      onWriteError: (_error, failed) => void failures.push(failed)
    })
    h.submit(ladderKey)
    expect(() =>
      h.end(ended(ladderKey, 'settled', { cancel: [], report: { status: 'applied' } }, ['0x01']))
    ).not.toThrow()
    expect(h.reporter.reports.writeFailures()).toBe(failures.length)
    expect(failures).toContainEqual({
      event: 'cycle.completed',
      workflow: 'ladder',
      marketId: ladderId
    })
    expect(failures).toContainEqual({
      event: 'transaction.settled',
      workflow: 'ladder',
      marketId: ladderId
    })
    for (const failed of failures)
      expect(Object.keys(failed as object).toSorted()).toEqual(['event', 'marketId', 'workflow'])
  })

  test('returns from a write at once, whatever the writer does after', () => {
    let pending = 0
    const h = harness({
      emit: () => {
        pending += 1
        void new Promise(() => undefined)
      }
    })
    expect(completed(h.poll())).toHaveLength(2)
    expect(pending).toBeGreaterThan(0)
  })
})

describe('the failure budget', () => {
  const failing = { ...rest('ladder', ladderId), status: 'failed', stage: 'market-read' } as const

  test('exhausts after consecutive failing polls of one market', () => {
    const h = harness()
    h.decide(ladderKey, failing)
    for (let poll = 1; poll < MARKET_FAILURE_BUDGET_CYCLES; poll += 1) h.poll()
    expect(h.exhausted()).toEqual([])
    h.poll()
    expect(h.exhausted()).toEqual(['ladder'])
  })

  test('counts a poll once, and never one its market spends in flight', () => {
    const h = harness()
    h.decide(ladderKey, failing)
    for (let poll = 1; poll < MARKET_FAILURE_BUDGET_CYCLES; poll += 1) h.poll()
    h.submit(ladderKey)
    h.poll()
    h.other()
    expect(h.exhausted()).toEqual([])
  })

  test('clears on a healthy poll', () => {
    const h = harness()
    h.decide(ladderKey, failing)
    for (let poll = 1; poll < MARKET_FAILURE_BUDGET_CYCLES; poll += 1) h.poll()
    h.decide(ladderKey, rest('ladder', ladderId))
    h.poll()
    h.decide(ladderKey, failing)
    for (let poll = 1; poll < MARKET_FAILURE_BUDGET_CYCLES; poll += 1) h.poll()
    expect(h.exhausted()).toEqual([])
  })

  test('keeps counting an act that did not settle until a later act applies', () => {
    const h = harness()
    h.submit(ladderKey)
    h.end(ended(ladderKey, 'refused', {}))
    for (let poll = 0; poll < MARKET_FAILURE_BUDGET_CYCLES - 1; poll += 1) h.poll()
    expect(h.exhausted()).toEqual([])
    h.poll()
    expect(h.exhausted()).toEqual(['ladder'])
  })

  test('counts a failure its preparation decides, never the preparing that preceded it', () => {
    const h = harness()
    for (let poll = 0; poll < MARKET_FAILURE_BUDGET_CYCLES; poll += 1) {
      h.decide(ladderKey, preparing('ladder', ladderId))
      h.poll()
      expect(h.exhausted()).toEqual([])
      h.decide(ladderKey, { ...failing, stage: 'reconcile' })
      h.other()
    }
    expect(h.exhausted()).toEqual(['ladder'])
  })

  test('never counts a market still preparing at the next read as timed out', () => {
    const h = harness()
    for (let poll = 0; poll <= MARKET_FAILURE_BUDGET_CYCLES; poll += 1) {
      h.decide(ladderKey, preparing('ladder', ladderId))
      h.other()
      h.poll()
    }
    expect(h.exhausted()).toEqual([])
  })

  test('counts a preparation that outlives its deadline until the budget is exhausted', () => {
    const h = harness()
    h.decide(ladderKey, preparing('ladder', ladderId))
    for (let poll = 0; poll < MARKET_FAILURE_BUDGET_CYCLES; poll += 1) {
      expect(h.exhausted()).toEqual([])
      h.poll()
      h.timeOut(ladderKey)
    }
    expect(h.exhausted()).toEqual(['ladder'])
  })

  test('clears a bootstrap market on an observation that resolves it', () => {
    const h = harness()
    h.submit(bootstrapKey)
    h.end(ended(bootstrapKey, 'failed', {}))
    h.poll()
    h.decide(bootstrapKey, { ...rest('bootstrap', bootstrapId), action: 'target-reached' })
    for (let poll = 0; poll < MARKET_FAILURE_BUDGET_CYCLES; poll += 1) h.poll()
    expect(h.exhausted()).toEqual([])
  })
})

describe('the polls', () => {
  test('poll once per world read and never on other steps', () => {
    const h = harness()
    h.other()
    h.poll()
    h.other()
    expect(h.counted).toHaveLength(1)
  })

  test('name a market whose reading reached its initial target, even while it is in flight', () => {
    const h = harness()
    h.reach(bootstrapKey)
    h.decide(bootstrapKey, rest('bootstrap', bootstrapId))
    h.submit(bootstrapKey)
    h.poll()
    expect(h.counted.at(-1)).toMatchObject({ completed: [bootstrapId] })
    expect(
      (h.counted.at(-1) as Extract<QuoterReport, { type: 'poll' }>).counted.map(
        report => report.workflow
      )
    ).toEqual(['ladder'])
  })
})
