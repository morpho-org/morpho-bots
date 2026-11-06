import type { Data, Node, Runner, RunnerOptions, Source } from '@repo/engine'
import type {
  Entry,
  Inclusion,
  KernelRequest,
  KernelState,
  Notice,
  ReportCommand,
  SendStatus
} from '@repo/kernel'
import type { Hex, LocalAccount } from 'viem'

import { intentIdOf, runIdAt, withdrawal } from '@repo/controller'
import {
  createGraph,
  createRunner,
  DEFAULT_JOURNAL_IO_TIMEOUT_MS,
  GraphFailedError
} from '@repo/engine'
import { createJournalFileSink, type JournalBuildIdentity, type JournalRunCap } from '@repo/kit'
import { tryCatch } from '@repo/utils'
import { midnightCancellation, midnightCommitmentGroup } from '@repo/validators'
import { join } from 'node:path'

import type { PrepareAnswer } from './application/engine/market-decision'
import type { WorldAccounting } from './application/engine/world'
import type { MonitoringEvent } from './application/monitoring/monitoring-event'
import type { SetupCheckService } from './application/setup/setup-check.service'
import type { ConfigService } from './config/config.service'
import type { QuoterHosting } from './graph'
import type { BootstrapAdapters } from './infrastructure/bootstrap/production-bootstrap'
import type { ActEvent } from './infrastructure/engine/quoter-acts'
import type { WorldReads } from './infrastructure/engine/world-reads'
import type { QuoterOwnership } from './infrastructure/kernel/quoter-holdings'
import type { LadderAdapters } from './infrastructure/ladder/production-ladder'
import type { ReferenceRates } from './infrastructure/reference/reference-rates'
import type { QuoterReports, WriteFailure } from './report'

import { marketKey } from './application/engine/readings'
import {
  adapterOperationField,
  operatorErrorName
} from './application/monitoring/operator-error-name.utils'
import { SETUP_CHECK_MONITOR_INTERVAL_MS } from './application/setup/setup-check.service'
import { ratifierType } from './config/supported-chains.utils'
import {
  ActFailedError,
  KernelRefusedError,
  QuoterStartError,
  LadderAdapterError,
  SetupCheckAbortedError
} from './errors'
import { declareQuoter, type PreparationWorld } from './graph'
import { isBelowMinimumOfferRejection } from './infrastructure/bootstrap/bootstrap-mempool-validation.utils'
import { createProductionBootstrapAdapters } from './infrastructure/bootstrap/production-bootstrap'
import { BOOTSTRAP_MONITOR_INTERVAL_MS, quoterPollMs } from './infrastructure/engine/quoter-cadence'
import { createWorldReads } from './infrastructure/engine/world-reads'
import { createQuoterOwnership } from './infrastructure/kernel/quoter-holdings'
import { createProductionLadderAdapters } from './infrastructure/ladder/production-ladder'
import { productionReferenceRates } from './infrastructure/reference/reference-rates'
import { strategyStateDirectory } from './infrastructure/strategy-state/strategy-state-file.utils'
import { createKernelLog, dryHosting, followedChain, quoterKernelSpec } from './kernel'
import { createQuoterReporter } from './report'

/** What a run's kernel reported when it stopped, and whether a halt or a failed step stopped it. */
export type QuoterStop = Readonly<{
  outcome: 'clean' | 'unsafe' | 'refused'
  reason: string
  halt?: string
  error?: unknown
}>

/** How the startup withdrawal of what an earlier run left ended, and what it included. */
export type StartupWithdrawal = Readonly<{ notice: Notice; included: readonly Inclusion[] }>

/** A running quoter's handles: how it stops or settles, and what its kernel holds. */
export type QuoterEngine = Readonly<{
  /** Resolves once the kernel stops, or the graph fails, and says how. */
  stopped: Promise<QuoterStop>
  /** A one-shot run's end: every market steady with nothing in flight; rejects if an act fails. */
  settled: Promise<void>
  /** Asks the kernel to withdraw everything and stop. */
  stop: () => void
  /** Stops at once, leaving what the kernel holds for the next start. */
  abandon: () => Promise<void>
  /** The groups the kernel holds exposed or live now. */
  held: () => readonly Hex[]
  /** A copy of the kernel's current state, for inspection. */
  kernelState: () => KernelState | undefined
  /** Whether every market rested with nothing in flight at the last step. */
  steady: () => boolean
  /** Reads the world and the references again now, after a change the bot did not make. */
  refresh: () => void
  reports: QuoterReports
}>

const STOP_REQUESTED = 'stop requested'
const ENDED = new Set<Notice>(['refused', 'abandoned', 'settled', 'compensated', 'failed'])
const BROADCAST = new Set<SendStatus>(['accepted', 'unknown'])
/** The startup withdrawal of what an earlier run left: it names no market. */
const STARTUP_KEY = 'startup'
/** How often startup looks again at the kernel it waits on. */
const STARTUP_POLL_MS = 100

/** Waits until `done`, or until the run stops or `signal` aborts, saying which. */
const until = async (
  done: () => boolean,
  stopped: Promise<unknown>,
  pollMs: number,
  signal?: AbortSignal
): Promise<boolean> => {
  let over = false
  void stopped.then(
    () => (over = true),
    () => (over = true)
  )
  while (!done()) {
    if (over || signal?.aborted) return false
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  return true
}

const JOURNAL_CAPACITY_BYTES = 16 * 1024 * 1024

const openJournalFile = (journal: JournalSettings, stateDirectory?: string) =>
  createJournalFileSink({
    directory: join(strategyStateDirectory(stateDirectory), 'journal'),
    graph: 'quoter',
    build: journal.build,
    capacityBytes: JOURNAL_CAPACITY_BYTES,
    runCapBytes: journal.runCapBytes
  })

/** What a run's kernel reported, as the run reads it. */
const stopOf = (report: ReportCommand): QuoterStop => ({
  outcome: report.outcome,
  reason: report.reason,
  ...(report.reason === STOP_REQUESTED ? {} : { halt: report.reason })
})

/** The preparation for the strategies that have markets, unless a test replaces it. */
const adaptersFor = (
  config: ConfigService,
  context: Readonly<{ reads: WorldReads }>,
  markets: Readonly<{ ladder: number; bootstrap: number }>,
  overrides?: Readonly<{ ladder?: () => LadderAdapters; bootstrap?: () => BootstrapAdapters }>
) => ({
  ...(markets.ladder > 0
    ? { ladder: overrides?.ladder?.() ?? createProductionLadderAdapters(config, context) }
    : {}),
  ...(markets.bootstrap > 0
    ? { bootstrap: overrides?.bootstrap?.() ?? createProductionBootstrapAdapters(config, context) }
    : {})
})

/** What names this run's journal and when it stops to start a fresh one. */
export type JournalSettings = Readonly<{ build: JournalBuildIdentity; runCapBytes: number }>

/** The parameters a run of the quoter starts from. */
type EngineParameters = Readonly<{
  config: ConfigService
  strategies: Readonly<{ ladder: boolean; bootstrap: boolean }>
  account?: LocalAccount
  setup?: Readonly<{
    create: (ownership: QuoterOwnership) => SetupCheckService
    monitor: boolean
    /** Replaces the timer between monitoring cycles, for tests. */
    wait?: (ms: number, signal: AbortSignal) => Promise<void>
  }>
  adapters?: Readonly<{ ladder?: () => LadderAdapters; bootstrap?: () => BootstrapAdapters }>
  world?: WorldReads
  references?: ReferenceRates
  /** Replaces the kernel's hosting, for tests. */
  kernel?: QuoterHosting
  writeEvent?: (event: MonitoringEvent) => void
  /** Every act event, after the engine's own handling. */
  onEvent?: (event: ActEvent) => void
  signal?: AbortSignal
  until?: 'settled'
  adopt?: (entry: Entry) => 'withdraw' | 'keep'
  /**
   * Groups the startup withdrawal also cancels, whether or not the kernel holds them; one it does
   * not hold is cancelled as cancel-only and retires nothing.
   */
  cancel?: readonly Hex[]
  /** Told how the startup withdrawal ended, before startup goes on. */
  onStartup?: (withdrawal: StartupWithdrawal) => void
  /** Told each transaction the startup withdrawal broadcasts, whether or not it is ever included. */
  onStartupSent?: (hash: Hex) => void
  dryEntries?: Readonly<Record<string, Entry>>
  stateDirectory?: string
  now?: () => number
  /** The journal file under the state directory, or a sink that replaces it; finalized if the runner cannot be created. */
  journal: JournalSettings | NonNullable<RunnerOptions['journal']>
}>

/** The signer's kernel for a writer, a dry one that signs nothing without an account, or a test's. */
const hostingFor = (parameters: EngineParameters, writeEvent: (event: MonitoringEvent) => void) => {
  const { config } = parameters
  const live = parameters.account
    ? quoterKernelSpec({
        config,
        account: parameters.account,
        writeEvent,
        ...(parameters.stateDirectory ? { stateDirectory: parameters.stateDirectory } : {})
      })
    : undefined
  return {
    hosting:
      parameters.kernel ??
      live?.hosting ??
      dryHosting(config, parameters.dryEntries, writeEvent, followedChain(config)),
    signer: live?.signer ?? config.setup.maker,
    dry: live === undefined
  }
}

const accountingOf = (config: ConfigService): WorldAccounting => ({
  maker: config.identity.maker,
  marketIds: config.setup.marketIds,
  ...(config.setup.acceptedLossFactor
    ? { acceptedLossFactor: config.setup.acceptedLossFactor }
    : {}),
  v0OfferGroupIds: config.v0OfferGroupIds
})

/** A strategy's preparation, with a throw kept as a sanitized failed answer. */
const preparationOf =
  (adapters: ReturnType<typeof adaptersFor>) =>
  (
    strategy: 'ladder' | 'bootstrap',
    params: Data,
    world: PreparationWorld
  ): Promise<PrepareAnswer> =>
    (strategy === 'ladder'
      ? adapters.ladder!.prepareReplacement({ ...(params as object), ...world } as never)
      : adapters.bootstrap!.prepareReplacement({ ...(params as object), ...world } as never)
    ).then(
      value => ({ ok: true as const, value }) as PrepareAnswer,
      (error: unknown) =>
        ({
          ok: false,
          errorName: operatorErrorName(error),
          ...adapterOperationField(error),
          ...(isBelowMinimumOfferRejection(error) ? { minimumAssets: error.minimumAssets } : {})
        }) as PrepareAnswer
    )

/** A one-shot run's end: steady, or failed by an act that ended unsettled, or by a stop. */
const settlement = () => {
  let failed: ActFailedError | undefined
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  void promise.catch(() => undefined)
  return {
    settled: promise,
    steady: () => resolve(),
    failed: (error: ActFailedError) => (failed ??= error),
    stopped: (reason: string) => reject(failed ?? new ActFailedError('', 'stopped', reason))
  }
}

/**
 * The cancellation of every adopted group startup withdraws, and of each `unheld` group, as the
 * kernel takes it; the witness names the unheld groups so they retire nothing.
 */
const withdrawalOf = (
  domain: QuoterGraph['domain'],
  config: ConfigService,
  intentId: string,
  adopted: readonly Entry[],
  unheld: readonly Hex[],
  head: number,
  now: number
): KernelRequest => ({
  type: 'Submit',
  plan: withdrawal(domain, {
    intentId,
    steps: [
      {
        kind: 'tx',
        payload: midnightCancellation(config.chainId, config.setup.maker, [
          ...adopted.map(entry => midnightCommitmentGroup(entry.spec.id)),
          ...unheld
        ]),
        ...(unheld.length > 0 && { witness: { cancelOnly: unheld } })
      }
    ],
    expiresAt: now + config.transactionReceiptTimeoutMs,
    basisBlock: head,
    conflicts: {}
  })
})

type QuoterGraph = ReturnType<typeof declareQuoter>

/** Whether an entry is one an earlier run left that startup withdraws. */
const adoptedFor = (adopt: EngineParameters['adopt']) => (entry: Entry) =>
  entry.adopted === true &&
  (entry.state === 'exposed' || entry.state === 'live') &&
  (adopt?.(entry) ?? 'withdraw') === 'withdraw'

/**
 * Starts the kernel, withdraws what an earlier run left, checks readiness, then opens the gate.
 * Every refusal, and an abort of `parameters.signal`, stops the kernel first, through `fail`.
 */
const openGate = async (run: {
  parameters: EngineParameters
  kernel: QuoterGraph['kernel']
  domain: QuoterGraph['domain']
  push: <T>(node: Source<T, 'occurrence'>, value: T) => void
  start: () => Promise<void>
  state: () => KernelState | undefined
  stopped: Promise<QuoterStop>
  fail: (cause: unknown) => Promise<never>
  startup: Readonly<{ id: string; ended: () => StartupWithdrawal | undefined }>
  readiness: () => SetupCheckService | undefined
  gate: Source<true, 'occurrence'>
  now: () => number
}) => {
  const { parameters, fail } = run
  const lifecycle = () => run.state()?.lifecycle.kind
  const wait = async (done: () => boolean) => {
    await until(done, run.stopped, STARTUP_POLL_MS, parameters.signal)
    if (parameters.signal?.aborted) await fail(new SetupCheckAbortedError())
  }
  await run.start()
  await wait(() => lifecycle() !== 'idle' && lifecycle() !== 'starting')
  if (lifecycle() !== 'running') await fail(new KernelRefusedError('start'))

  const adopted = Object.values(run.state()!.entries).filter(adoptedFor(parameters.adopt))
  const adoptedGroups = new Set(
    adopted.map(entry => midnightCommitmentGroup(entry.spec.id).toLowerCase())
  )
  const unheld = [
    ...new Set((parameters.cancel ?? []).map(group => group.toLowerCase() as Hex))
  ].filter(group => !adoptedGroups.has(group))
  if (adopted.length > 0 || unheld.length > 0) {
    const head = run.state()?.head?.number ?? 0
    const withdrawal = withdrawalOf(
      run.domain,
      parameters.config,
      run.startup.id,
      adopted,
      unheld,
      head,
      run.now()
    )
    run.push(run.kernel.nodes.requests, withdrawal)
    await wait(() => run.startup.ended() !== undefined)
    const ended = run.startup.ended()
    if (ended) parameters.onStartup?.(ended)
    const remaining = Object.values(run.state()?.entries ?? {}).filter(adoptedFor(parameters.adopt))
    if (ended?.notice !== 'settled' || remaining.length > 0 || lifecycle() !== 'running')
      await fail(new KernelRefusedError('adopted'))
  }

  await run.readiness()?.assertReady(parameters.signal).catch(fail)
  if (lifecycle() !== 'running') await fail(new KernelRefusedError('start'))
  run.push(run.gate, true)
}

/**
 * Runs the quoter on the engine: one graph over every configured market of the selected strategies
 * and the kernel for its signer, or a dry kernel that signs nothing without an account. Startup
 * withdraws every commitment an earlier run left, checks readiness, then opens the gate.
 * @param parameters - The configuration and strategies, the signing account (a run without one is
 * dry and sends nothing), readiness checked once before the gate opens and optionally monitored,
 * the monitoring writer, and which commitments an earlier run left startup withdraws: all of them
 * unless `adopt` says `keep`.
 * @returns The running quoter.
 * @throws `QuoterStartError` when the kernel refuses to start, what an earlier run left cannot be
 * withdrawn, the startup readiness check fails, or `signal` aborts during startup; the kernel is
 * stopped first.
 */
export const startQuoterEngine = async (parameters: EngineParameters): Promise<QuoterEngine> => {
  const { config } = parameters
  const now = parameters.now ?? Date.now
  const ladder = parameters.strategies.ladder ? config.ladder : []
  const bootstrap = parameters.strategies.bootstrap ? config.bootstrap : []
  const reads = parameters.world ?? createWorldReads(config)
  const writeEvent = (event: MonitoringEvent) => parameters.writeEvent?.(event)
  const { hosting, signer, dry } = hostingFor(parameters, writeEvent)
  const keys = [
    ...bootstrap.map(item => marketKey('bootstrap', item.marketId)),
    ...ladder.map(item => marketKey('ladder', item.marketId))
  ]
  const reporter = createQuoterReporter({
    keys,
    emit: writeEvent,
    onWriteError: (error: unknown, failed: WriteFailure) =>
      console.error(
        JSON.stringify({
          event: 'monitoring.write-failed',
          errorName: operatorErrorName(error),
          failed
        })
      )
  })

  let runner: Runner | undefined
  const read = <T>(node: Node<T>) => runner?.read(node)
  const kernelState = () => read(graph.kernel.nodes.state)
  const ownership = createQuoterOwnership(
    kernelState,
    () => Object.values(read(graph.acts.state)?.publications ?? {}),
    config.v0OfferGroupIds
  )
  const adapters = adaptersFor(
    config,
    { reads },
    { ladder: ladder.length, bootstrap: bootstrap.length },
    parameters.adapters
  )
  const runId = runIdAt(now())
  const startupId = intentIdOf(STARTUP_KEY, runId, 0)
  let startup: StartupWithdrawal | undefined
  const settling = settlement()
  const logKernel = createKernelLog(writeEvent)

  const g = createGraph('quoter')
  const graph = declareQuoter(g, {
    runId,
    ladder,
    bootstrap,
    accounting: accountingOf(config),
    signing: {
      chainId: config.chainId,
      maker: config.setup.maker,
      signer,
      ratifier: () => {
        const type = ratifierType(config.setup.ratifier, config.chainId)
        if (!type) throw new LadderAdapterError('unsupported-ratifier')
        return type
      }
    },
    kernel: hosting,
    dry,
    reads,
    rates: parameters.references ?? productionReferenceRates(config),
    prepare: preparationOf(adapters),
    validate: (workflow, tree, payload) =>
      workflow === 'ladder'
        ? adapters.ladder!.validateRatified(tree)
        : adapters.bootstrap!.validateRatified(payload),
    timing: {
      everyMs: quoterPollMs(ladder),
      bootstrapEveryMs: BOOTSTRAP_MONITOR_INTERVAL_MS,
      receiptTimeoutMs: config.transactionReceiptTimeoutMs
    },
    now,
    ...(parameters.setup?.monitor && {
      readiness: {
        create: parameters.setup.create,
        intervalMs: SETUP_CHECK_MONITOR_INTERVAL_MS,
        ...(parameters.setup.wait && { wait: parameters.setup.wait })
      }
    }),
    onActivity: activity => {
      for (const a of activity) {
        if (a.type === 'sent' && a.intentId === startupId && BROADCAST.has(a.status))
          parameters.onStartupSent?.(a.hash as Hex)
        if (a.type === 'alarm') writeEvent({ event: 'kernel.alarm', reason: a.reason })
        if (a.type !== 'notice') continue
        if (a.intentId === startupId && ENDED.has(a.notice))
          startup = { notice: a.notice, included: a.included ?? [] }
        writeEvent({
          event: 'kernel.notice',
          intentId: a.intentId,
          notice: a.notice,
          ...(a.reason ? { reason: a.reason } : {})
        })
      }
      if (!dry) logKernel(activity)
    },
    onReport: reporter.onReport,
    onAdvance: ({ intentId, stage, block }) =>
      writeEvent({ event: 'kernel.advance', intentId, stage, block }),
    onSetup: reporter.onSetup,
    onEvent: event => {
      if (parameters.until === 'settled') {
        if (event.type === 'steady') settling.steady()
        if (event.type === 'ended' && event.outcome.notice !== 'settled') {
          const { notice, reason } = event.outcome
          settling.failed(new ActFailedError(event.key, notice, reason))
          active.push(graph.kernel.nodes.requests, { type: 'Halt', reason: `act ${notice}` })
        }
      }
      parameters.onEvent?.(event)
    }
  })
  let journal: NonNullable<RunnerOptions['journal']>
  let runCapReached: Promise<JournalRunCap> | undefined
  if ('sink' in parameters.journal) journal = parameters.journal
  else {
    const file = await openJournalFile(parameters.journal, parameters.stateDirectory)
    if (file.pruned.files > 0) writeEvent({ event: 'journal.pruned', ...file.pruned })
    journal = file.journal
    runCapReached = file.runCapReached
  }
  try {
    runner = createRunner(g.build(), { now, journal })
  } catch (error) {
    const finalized = await tryCatch(
      journal.sink.finalize(
        AbortSignal.timeout(journal.ioTimeoutMs ?? DEFAULT_JOURNAL_IO_TIMEOUT_MS),
        { clean: false }
      )
    )
    throw finalized.error
      ? new AggregateError(
          [error, finalized.error],
          'the runner was not created and its journal did not finalize'
        )
      : error
  }
  const active = runner
  const reported = (report: ReportCommand): QuoterStop => {
    try {
      writeEvent({
        event: 'kernel.stopped',
        outcome: report.outcome,
        reason: report.reason,
        openEntries: report.open.entries.length,
        openNonces: report.open.nonces.length
      })
    } catch {
      // A failing writer must not turn how the kernel stopped into a rejection.
    }
    return stopOf(report)
  }
  const stopped: Promise<QuoterStop> = active.stopped.then(
    value => reported(value as ReportCommand),
    (error: unknown): QuoterStop =>
      error instanceof GraphFailedError && error.stop !== undefined
        ? { ...reported(error.stop as ReportCommand), error: error.cause }
        : { outcome: 'unsafe', reason: 'graph failed', error }
  )
  void stopped.then(report => settling.stopped(report.reason))
  const stop = () => active.push(graph.kernel.nodes.requests, { type: 'Stop' })
  const fail = async (cause: unknown): Promise<never> => {
    stop()
    throw new QuoterStartError(cause, await stopped)
  }

  await openGate({
    parameters,
    kernel: graph.kernel,
    domain: graph.domain,
    push: (node, value) => active.push(node, value),
    start: () => graph.kernel.start(active),
    state: kernelState,
    stopped,
    fail,
    startup: { id: startupId, ended: () => startup },
    readiness: () => parameters.setup?.create(ownership),
    gate: graph.gate,
    now
  })
  let ended = false
  void stopped.then(() => (ended = true))
  void runCapReached?.then(cap => {
    if (ended) return
    writeEvent({ event: 'journal.capped', ...cap })
    stop()
  })

  return {
    stopped,
    settled: settling.settled,
    stop,
    abandon: () => active.abandon(),
    kernelState: () => structuredClone(kernelState()),
    steady: () => read(graph.acts.state)?.steady === true,
    refresh: () => active.push(graph.gate, true),
    held: () =>
      Object.values(kernelState()?.entries ?? {}).flatMap(entry =>
        entry.state === 'exposed' || entry.state === 'live'
          ? [midnightCommitmentGroup(entry.spec.id)]
          : []
      ),
    reports: reporter.reports
  }
}
