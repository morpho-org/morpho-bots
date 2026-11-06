import type { WorkflowEvent } from '@repo/controller'
import type {
  Data,
  EffectRequest,
  GraphBuilder,
  Keyed,
  KeyedWrite,
  KeyRead,
  MapInputs,
  Samples,
  State,
  Stream
} from '@repo/engine'
import type { KernelHostOptions, KernelRequest, KernelState } from '@repo/kernel'
import type { Hex } from 'viem'

import { declareHaltPolicy, declareWorkflow, kernelDomain } from '@repo/controller'
import {
  digestOf,
  emitTo,
  every,
  keyedLevel,
  keyedMap,
  keyRecord,
  lane,
  latest,
  sample,
  watch
} from '@repo/engine'
import { declareKernel } from '@repo/kernel'
import { setTimeout as sleep } from 'node:timers/promises'

import type { Observed, Prepared } from './application/engine/decision'
import type { LadderCrossings } from './application/engine/ladder-decision'
import type { PrepareAnswer } from './application/engine/market-decision'
import type { Workflow } from './application/engine/market-report'
import type { ReferenceReading, SetupReading } from './application/engine/readings'
import type { WorldAccounting, WorldOwnership, WorldValue } from './application/engine/world'
import type { SetupCheckReport, SetupCheckService } from './application/setup/setup-check.service'
import type { ValidLadderConfig } from './domain/ladder'
import type { ValidBootstrapConfig } from './domain/position-bootstrap'
import type { ActEvent, Decided } from './infrastructure/engine/quoter-acts'
import type { QuoterSigning } from './infrastructure/engine/quoter-plans'
import type { Polls, QuoterReport } from './infrastructure/engine/quoter-polls'
import type { WorldBasis } from './infrastructure/engine/quoter-sources'
import type { WorldReads } from './infrastructure/engine/world-reads'
import type { Publication, QuoterOwnership } from './infrastructure/kernel/quoter-holdings'
import type { ReferenceRates } from './infrastructure/reference/reference-rates'

import {
  budgetVerdict,
  EMPTY_BUDGET,
  foldBudget,
  foldCompleted,
  reachesInitialTarget
} from './application/engine/cycles'
import { advanceCrossings } from './application/engine/ladder-decision'
import { decideMarket, marketReading, prepareRequest } from './application/engine/market-decision'
import { marketKey } from './application/engine/readings'
import { operatorErrorName } from './application/monitoring/operator-error-name.utils'
import { readinessVerdict } from './application/setup/setup-check.utils'
import { declareActs } from './infrastructure/engine/quoter-acts'
import { quoterMaterializer } from './infrastructure/engine/quoter-plans'
import { createPolls, NO_POLLS } from './infrastructure/engine/quoter-polls'
import { readReferences, readWorld, VALID_FOR_READS } from './infrastructure/engine/quoter-sources'
import {
  createQuoterOwnership,
  holdingsOf,
  liveViewOf
} from './infrastructure/kernel/quoter-holdings'

/** One world read at a time; a read whose tick aged past a poll while it queued is skipped. */
const WORLD_LANE = { concurrency: 1, queue: 64 }
/** References are read one call at a time, as the world is. */
const REFERENCE_LANE = { concurrency: 1, queue: 64 }
/** Preparations, at most one asked per market per world read. */
const PREPARE_LANE = { concurrency: 4, queue: 256 }
/**
 * A preparation still running a poll after it started answers a read already superseded, so it is
 * answered with this instead; its own late answer is never written.
 */
const PREPARATION_TIMED_OUT: PrepareAnswer = { ok: false, errorName: 'TimeoutError' }
/** How many polls a reference may lag the world it is decided beside before it reads as stale. */
const REFERENCE_POLLS = 3

/** What one readiness cycle found, or that it threw. */
type ReadinessCycle = Readonly<{ report: SetupCheckReport }> | Readonly<{ errorName: string }>

/** What a preparation reads beside its request: the maker's holdings as it starts. */
export type PreparationWorld = Readonly<{ ownership: WorldOwnership }>

/** A world read's basis, with the request it answers: the count of world reads asked for by then. */
type WorldReadBasis = WorldBasis & Readonly<{ generation: number }>

/** A market's preparation answer, for the request digest it was asked with. */
type PrepareResult = Readonly<{
  key: string
  seq: number
  digest: string
  answer: PrepareAnswer
  timedOut?: true
}>

/**
 * How the kernel is hosted, but for what the quoter's graph supplies itself, its publications'
 * payloads among them. `dry` marks a world that signs nothing, whose Ecrecover publications carry
 * the dry signature unverified.
 */
export type QuoterHosting = Omit<KernelHostOptions, 'requests' | 'facts' | 'onActivity' | 'now'> &
  Readonly<{ dry?: true }>

type QuoterGraphOptions = Readonly<{
  runId: string
  ladder: readonly ValidLadderConfig[]
  bootstrap: readonly ValidBootstrapConfig[]
  accounting: WorldAccounting
  signing: QuoterSigning
  kernel: QuoterHosting
  /** Whether the kernel's world signs and sends nothing, so an act reports as logged. */
  dry: boolean
  reads: WorldReads
  rates: ReferenceRates
  /** Prepares one market's replacement; a failure comes back as a failed answer, never a throw. */
  prepare: (strategy: Workflow, params: Data, world: PreparationWorld) => Promise<PrepareAnswer>
  validate: Parameters<typeof quoterMaterializer>[0]['validate']
  timing: Readonly<{ everyMs: number; bootstrapEveryMs: number; receiptTimeoutMs: number }>
  now: () => number
  /**
   * Monitors readiness for the rest of the run once the gate opens, `intervalMs` after each cycle
   * ends; a halting report halts the kernel.
   */
  readiness?: Readonly<{
    create: (ownership: QuoterOwnership) => SetupCheckService
    intervalMs: number
    /** Resolves once `ms` have passed, or at once on `signal`; a timer unless a test replaces it. */
    wait?: (ms: number, signal: AbortSignal) => Promise<void>
  }>
  onActivity?: KernelHostOptions['onActivity']
  onReport?: (report: QuoterReport) => void
  onSetup?: (reading: SetupReading) => void
  onEvent?: (event: ActEvent) => void
  onAdvance?: (event: WorkflowEvent) => void
}>

const workflowOf = (key: string) => key.split(':') as [Workflow, Hex]

/**
 * A market's reference as its decision reads it: failed once its latest read failed, or once it
 * lags the world by too much.
 */
const referenceOf = (
  references: Keyed<ReferenceReading> | undefined,
  key: string,
  worldReadAt: number,
  maxAgeMs: number
): Observed<ReferenceReading> => {
  const fact = references === undefined ? undefined : keyRecord(references, key)
  if (fact?.status === 'failed')
    return { status: 'failed', failure: { code: fact.reason ?? 'unknown' } }
  if (fact?.status !== 'present') return { status: 'unobserved' }
  const readAt = (fact.basis as { readAt: number }).readAt
  if (worldReadAt - readAt > maxAgeMs) return { status: 'failed', failure: { code: 'stale' } }
  return { status: 'ready', value: fact.value }
}

/** Waits on a timer, ending early and quietly once `signal` aborts. */
const timer = (ms: number, signal: AbortSignal) =>
  sleep(ms, undefined, { signal }).catch(() => undefined)

/**
 * Readiness monitoring in the graph: the fold `quoter.readiness.schedule` wakes a cycle when the
 * gate opens and, at exactly `intervalMs` after each one ends, until one halts; the effect
 * `quoter.readiness.wait` holds each wake until its time, and `quoter.readiness.check` runs the
 * cycle against the maker's holdings as the graph holds them. Each report, with whether it halts,
 * is written to `quoter.setup`; a cycle that throws halts.
 */
const declareReadiness = (
  g: GraphBuilder,
  options: Readonly<{
    gate: Stream<true>
    holdings: Readonly<{
      state: State<KernelState>
      acts: State<Readonly<{ publications: Readonly<Record<string, Publication>> }>>
    }>
    readiness: QuoterGraphOptions['readiness']
    v0OfferGroupIds: readonly Hex[]
  }>
) => {
  if (!options.readiness) return g.occurrences<SetupReading>('quoter.setup')
  const { create, intervalMs, wait = timer } = options.readiness
  const setup = g.node<SetupReading>('quoter.setup')
  const cycles = g.node<ReadinessCycle>('quoter.readiness.cycles')
  const wakes = g.node<number>('quoter.readiness.wakes')
  const due = g.node<true>('quoter.readiness.due')
  g.fold('quoter.readiness.schedule', {
    reads: { gate: every(options.gate), cycle: every(cycles) },
    emits: [wakes, setup],
    initial: { open: false, transientCycles: 0 },
    applyInput: (state, input) => {
      if (input.from === 'gate') {
        if (state.open) return { state }
        return { state: { ...state, open: true }, emit: [emitTo(wakes, input.stamp.at)] }
      }
      const cycle = input.value
      if ('errorName' in cycle) {
        const reading = {
          report: { ready: false, checks: [] },
          halting: true,
          cycleErrorName: cycle.errorName
        }
        return { state, emit: [emitTo(setup, reading)] }
      }
      const verdict = readinessVerdict(state.transientCycles, cycle.report)
      return {
        state: { ...state, transientCycles: verdict.transientCycles },
        emit: [
          emitTo(setup, { report: cycle.report, halting: verdict.halting }),
          ...(verdict.halting ? [] : [emitTo(wakes, input.stamp.at + intervalMs)])
        ]
      }
    }
  })
  g.effect('quoter.readiness.wait', {
    requests: { at: every(wakes) },
    results: due,
    lane: lane('readiness.wait', { concurrency: 1, queue: 1 }),
    handle: async ({ value: at }, context) => {
      await wait(Math.max(0, at - context.now()), context.signal)
      if (!context.signal.aborted) context.write(true)
    }
  })
  g.effect('quoter.readiness.check', {
    requests: { due: every(due) },
    samples: options.holdings,
    results: cycles,
    lane: lane('readiness', { concurrency: 1, queue: 1 }),
    handle: async (_, context) => {
      const ownership = createQuoterOwnership(
        context.samples.state,
        () => Object.values(context.samples.acts().publications),
        options.v0OfferGroupIds
      )
      try {
        const report = await create(ownership).cycle(context.signal)
        if (!context.signal.aborted) context.write({ report })
      } catch (error) {
        context.write({ errorName: operatorErrorName(error) })
      }
    }
  })
  return setup
}

/**
 * The quoter as one graph over its kernel. A clock, and each inclusion or end of an act of ours,
 * reads the world at the kernel's head, with the
 * maker's holdings as the kernel and this run's publications show them; each market's decision is
 * a pure function of that read, its reference, and its preparation's answer; its desire is the fact
 * a replacement rests on, so a reference that moves within tolerance never stops one, and the
 * workflow advances a ratified tree to publication only while its market still desires it. The
 * acting policy affirms, sends, supersedes and withdraws; the failure budget and setup readiness
 * halt the kernel through monitors. A preparation still running one poll interval
 * (`timing.everyMs`) after it starts answers `TimeoutError`, is reported and counted as a failed
 * `prepare`, and its later answer is discarded.
 * @param g - Graph builder the quoter's nodes are declared on.
 * @param options - The run's markets, accounting, signing, kernel hosting, reads, timing, and
 * observers.
 * @returns The graph's nodes.
 */
export const declareQuoter = (g: GraphBuilder, options: QuoterGraphOptions) => {
  const { timing } = options
  const configs = new Map<string, ValidLadderConfig | ValidBootstrapConfig>([
    ...options.ladder.map(config => [marketKey('ladder', config.marketId), config] as const),
    ...options.bootstrap.map(config => [marketKey('bootstrap', config.marketId), config] as const)
  ])
  const keys = [...configs.keys()]
  const maxReferenceAgeMs = REFERENCE_POLLS * Math.max(timing.everyMs, timing.bootstrapEveryMs)

  const gate = g.occurrences<true>('quoter.gate')
  const poll = g.clock('quoter.poll', { everyMs: timing.everyMs, value: now => now })
  const worldWrites = g.node<KeyedWrite<WorldValue, WorldReadBasis>>('world.reads')
  const world = keyedLevel(g, 'world', worldWrites)
  const worldRequests = g.node<number>('world.requests')
  const requested = g.reserve<number>('world.requested')
  const referenceWrites = g.node<KeyedWrite<ReferenceReading>>('references.reads')
  const references = keyedLevel(g, 'references', referenceWrites)
  const prepareResults = g.node<PrepareResult>('quoter.prepared.results')
  const prepared = g.fold('quoter.prepared', {
    reads: { result: every(prepareResults) },
    initial: {} as Readonly<Record<string, PrepareResult>>,
    applyInput: (answers, { value }) =>
      (answers[value.key]?.seq ?? -1) > value.seq
        ? { state: answers }
        : { state: { ...answers, [value.key]: value } }
  })
  const actRequests = g.node<KernelRequest>('quoter.requests')
  const advances = g.node<KernelRequest>('quoter.workflow.requests')
  const budgetHalts = g.node<KernelRequest>('quoter.budget.requests')
  const readinessHalts = g.node<KernelRequest>('quoter.readiness.requests')
  const referenceHalts = g.node<KernelRequest>('quoter.references.requests')
  const reports = g.node<QuoterReport>('quoter.reports')
  const events = g.node<ActEvent>('quoter.acts.events')

  const crossings = g.fold('ladder.crossings', {
    reads: { event: every(events) },
    initial: {} as Readonly<Record<string, LadderCrossings>>,
    applyInput: (state, { value }) => {
      if (value.type !== 'ended' || value.outcome.notice !== 'settled') return { state }
      if (value.outcome.kind !== 'replace' || !value.key.startsWith('ladder:')) return { state }
      const payload = value.outcome.payload as Parameters<typeof advanceCrossings>[1]
      return {
        state: { ...state, [value.key]: advanceCrossings(state[value.key] ?? {}, payload) }
      }
    }
  })
  const completed = g.fold('markets.completed', {
    reads: { report: every(reports) },
    initial: [] as readonly string[],
    applyInput: (state, { value }) =>
      value.type === 'poll'
        ? { state: foldCompleted(state, { counted: [], completed: value.completed }) }
        : { state }
  })

  const decisionInputs = {
    requested: latest(requested),
    references: latest(references),
    prepared: latest(prepared),
    crossings: sample(crossings),
    completed: sample(completed)
  }
  const decide = (
    value: WorldValue,
    key: string,
    inputs: MapInputs<typeof decisionInputs>,
    { basis }: KeyRead<WorldReadBasis>
  ): Decided => {
    const config = configs.get(key)!
    const reading = marketReading(
      { ...value, block: basis.block, timestamp: basis.timestamp },
      config,
      options.accounting,
      (inputs.completed ?? []).includes(config.marketId)
    )
    const context = {
      reference: referenceOf(inputs.references, key, basis.readAt, maxReferenceAgeMs),
      view: value.view,
      crossings: inputs.crossings?.[key] ?? {},
      completed: (inputs.completed ?? []).includes(config.marketId)
    }
    const params = prepareRequest(reading, config, context)
    const digest =
      params === undefined ? undefined : digestOf({ params, generation: basis.generation })
    const answer = inputs.prepared?.[key]
    const noNewerRead = basis.generation === inputs.requested
    const prepare: Prepared<PrepareAnswer> =
      digest === undefined
        ? { status: 'unrequested' }
        : answer?.digest === digest && noNewerRead
          ? { status: 'ready', value: answer.answer }
          : { status: 'pending' }
    return {
      decision: decideMarket(reading, config, context, prepare),
      ...(params !== undefined &&
        noNewerRead && { request: { digest: digest!, params: params as Data } }),
      completes:
        reading.strategy === 'bootstrap' &&
        reachesInitialTarget(reading, config as ValidBootstrapConfig)
    }
  }

  const decisions = keyedMap(g, 'markets.decision', world, decide, { with: decisionInputs })
  const domain = kernelDomain('quoter')
  const desires = domain.fact(
    keyedMap(g, 'markets.desire', decisions, decided => decided.decision.desire)
  )

  const { dry: dryWorld, ...hosting } = options.kernel
  const kernel = declareKernel(g, {
    ...hosting,
    now: options.now,
    effects: {
      ...hosting.effects,
      materialize: quoterMaterializer({
        ...options.signing,
        validate: options.validate,
        dry: dryWorld === true
      })
    },
    requests: [actRequests, advances, budgetHalts, readinessHalts, referenceHalts],
    facts: domain.facts(),
    ...(options.onActivity && { onActivity: options.onActivity })
  })
  const acts = declareActs(g, {
    runId: options.runId,
    keys,
    domain,
    signing: options.signing,
    decisions,
    desires,
    world,
    kernel: kernel.nodes.state,
    activity: kernel.nodes.activity,
    gate,
    answers: prepareResults,
    requests: actRequests,
    events,
    receiptTimeoutMs: timing.receiptTimeoutMs,
    readValidityMs: VALID_FOR_READS * timing.everyMs
  })
  const workflow = declareWorkflow(g, 'quoter.workflow', {
    domain,
    state: kernel.nodes.state,
    facts: [desires],
    requests: advances
  })
  declareHaltPolicy(g, 'quoter.budget', {
    over: reports,
    requests: budgetHalts,
    initial: EMPTY_BUDGET,
    applyInput: (budget, report) => {
      if (report.type !== 'poll') return { state: budget }
      const next = foldBudget(budget, { counted: report.counted, completed: report.completed })
      const verdict = budgetVerdict(next)
      return {
        state: next,
        ...(!verdict.ok && { halt: `market-failure-budget: ${verdict.halt}` })
      }
    }
  })
  declareHaltPolicy(g, 'quoter.references', {
    over: referenceWrites,
    requests: referenceHalts,
    initial: null,
    applyInput: (state, write) => ({
      state,
      ...(write.coverage === 'failed' && { halt: 'reference-read-failed' })
    })
  })

  const polls = createPolls(keys, options.dry)
  const reported = ({ state, report }: { state: Polls; report?: QuoterReport }) => ({
    state,
    ...(report && { emit: [emitTo(reports, report)] })
  })
  g.fold('quoter.polls', {
    reads: {
      decisions: watch(decisions),
      world: watch(world),
      event: every(events),
      prepared: every(prepareResults)
    },
    emits: [reports],
    initial: NO_POLLS,
    applyInput: (state, input) =>
      reported(
        input.from === 'decisions'
          ? polls.decided(state, input.value.value)
          : input.from === 'world'
            ? polls.read(state, input.value.digest)
            : input.from === 'prepared'
              ? input.value.timedOut
                ? polls.timedOut(state, input.value.key)
                : { state }
              : polls.event(state, input.value)
      ),
    afterInputs: state => reported(polls.settle(state))
  })

  /** The world and references are read each poll, and again once an act of ours lands or ends. */
  const rereads = {
    tick: every(poll),
    gate: every(gate),
    event: every(events),
    activity: every(kernel.nodes.activity)
  }
  const rereadFor = (request: EffectRequest<typeof rereads>) => {
    if (request.from === 'event') return request.value.type === 'ended'
    if (request.from === 'activity')
      return request.value.some(activity => activity.type === 'included')
    return true
  }
  g.fold(requested, {
    reads: rereads,
    emits: [worldRequests],
    initial: 0,
    applyInput: (count, input) =>
      rereadFor(input)
        ? { state: count + 1, emit: [emitTo(worldRequests, count + 1)] }
        : { state: count }
  })

  const holdings = { state: kernel.nodes.state, acts: acts.state }
  const holdingsNow = (samples: Samples<typeof holdings>) =>
    holdingsOf(
      samples.state(),
      Object.values(samples.acts().publications),
      options.accounting.v0OfferGroupIds
    )

  const setup = declareReadiness(g, {
    gate,
    holdings,
    readiness: options.readiness,
    v0OfferGroupIds: options.accounting.v0OfferGroupIds
  })
  declareHaltPolicy(g, 'quoter.readiness', {
    over: setup,
    requests: readinessHalts,
    initial: null,
    applyInput: (state, reading) => ({
      state,
      ...(reading.halting && { halt: 'readiness: setup-failed' })
    })
  })

  g.effect('world.read', {
    requests: { generation: every(worldRequests) },
    samples: holdings,
    results: worldWrites,
    lane: lane('world', WORLD_LANE),
    handle: async ({ value: generation }, context) => {
      const readAt = context.now()
      if (readAt - context.stamp.at > timing.everyMs) return
      const state = context.samples.state()
      const { head } = state
      if (head === undefined) return
      const ownership = holdingsNow(context.samples)
      try {
        const read = await readWorld({
          at: head,
          readAt,
          ownership,
          views: Object.fromEntries(keys.map(key => [key, liveViewOf(state, key)])),
          reads: options.reads,
          markets: keys.map(key => {
            const [strategy, marketId] = workflowOf(key)
            return { strategy, marketId }
          }),
          accounting: options.accounting,
          expiry: readAt + VALID_FOR_READS * timing.everyMs
        })
        if (read.coverage === 'complete' || read.coverage === 'carried')
          context.write({ ...read, basis: { ...read.basis, generation } })
        else context.write(read)
      } catch (error) {
        context.write({ coverage: 'failed', reason: operatorErrorName(error) })
      }
    }
  })

  const bootstrapKeys = options.bootstrap.map(config => marketKey('bootstrap', config.marketId))
  const bootstrapDueAt = (read: Keyed<ReferenceReading>, at: number) =>
    bootstrapKeys.some(key => {
      const fact = keyRecord(read, key)
      if (fact.status !== 'present') return true
      return at - (fact.basis as { readAt: number }).readAt >= timing.bootstrapEveryMs
    })
  g.effect('references.read', {
    requests: rereads,
    samples: { references },
    results: referenceWrites,
    lane: lane('references', REFERENCE_LANE),
    handle: async (request, context) => {
      if (!rereadFor(request)) return
      const at = context.now()
      const bootstrapDue = bootstrapDueAt(context.samples.references(), at)
      const read = [
        ...options.ladder.map(config => marketKey('ladder', config.marketId)),
        ...(bootstrapDue ? bootstrapKeys : [])
      ]
      try {
        context.write(
          await readReferences({
            rates: options.rates,
            ladder: options.ladder.map(config => config.marketId),
            bootstrap: options.bootstrap.map(config => config.marketId),
            bootstrapDue,
            at
          })
        )
      } catch (error) {
        context.write({ coverage: 'failed', keys: read, reason: operatorErrorName(error) })
      }
    }
  })

  g.effect('quoter.preparation', {
    requests: { request: every(acts.prepare) },
    samples: holdings,
    results: prepareResults,
    lane: lane('preparation', PREPARE_LANE),
    sequence: ({ value }) => value.seq,
    handle: async ({ value: request }, context) => {
      const [strategy] = workflowOf(request.key)
      const answered = new AbortController()
      const answer = await Promise.race([
        options.prepare(strategy, request.params, { ownership: holdingsNow(context.samples) }),
        timer(timing.everyMs, AbortSignal.any([context.signal, answered.signal])).then(
          () => PREPARATION_TIMED_OUT
        )
      ]).finally(() => answered.abort())
      const { key, seq, digest } = request
      context.write({
        key,
        seq,
        digest,
        answer,
        ...(answer === PREPARATION_TIMED_OUT && { timedOut: true as const })
      })
    }
  })

  g.effect('quoter.report', {
    requests: {
      report: every(reports),
      setup: every(setup),
      event: every(events),
      advance: every(workflow.events)
    },
    finishOnStop: true,
    handle: ({ from, value }) => {
      if (from === 'setup') return options.onSetup?.(value)
      if (from === 'advance') return options.onAdvance?.(value)
      if (from === 'report') return options.onReport?.(value)
      options.onEvent?.(value)
    }
  })

  return {
    kernel,
    domain,
    gate,
    setup,
    world,
    references,
    decisions,
    desires,
    acts,
    reports,
    events
  }
}
