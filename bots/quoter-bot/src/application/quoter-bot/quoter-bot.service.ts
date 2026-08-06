import type { MonitorOperationQueue } from '@repo/monitoring'

import { createOperationQueue, cycleHasFailure } from '@repo/monitoring'

import type { BootstrapTransactionSubmittedEvent } from '../bootstrap/position-bootstrap-verbose'
import type { PositionBootstrapMonitorReport } from '../bootstrap/position-bootstrap.service'
import type { LadderMonitorReport } from '../ladder/ladder-market-maker.service'
import type { LadderTransactionSubmittedEvent } from '../ladder/ladder-verbose'
import type { SetupCheckMonitorReport, SetupCheckReport } from '../setup/setup-check.service'

import { operatorErrorName } from '../operator-error-name.utils'

/** Readiness monitor required by the combined quoter-bot lifecycle. */
export interface QuoterBotSetupMonitor {
  /**
   * Monitors complete setup readiness until shutdown or the first failed check.
   * @param parameters - Shared shutdown signal and completed-cycle observer.
   * @returns A sanitized terminal setup-monitor report.
   * @throws When monitor configuration is invalid before the lifecycle can start.
   */
  runContinuously(parameters: {
    signal: AbortSignal
    onCycle?: (report: SetupCheckReport) => void | Promise<void>
  }): Promise<SetupCheckMonitorReport>
}

/** Position-bootstrap monitor required by the combined quoter-bot lifecycle. */
export interface QuoterBotBootstrapMonitor {
  /**
   * Monitors position-bootstrap decisions and cleans owned offers after shutdown.
   * @param parameters - Shared signal, cycle observer, and optional verbose submission observer.
   * @returns A sanitized terminal bootstrap-monitor report after cleanup.
   * @throws When monitor configuration is invalid before cleanup ownership is established.
   */
  runContinuously(parameters: {
    signal: AbortSignal
    onCycle?: (
      results: readonly { status: string; [key: string]: unknown }[]
    ) => void | Promise<void>
    runOperation?: MonitorOperationQueue
    verbose?: boolean
    onTransactionSubmitted?: (event: BootstrapTransactionSubmittedEvent) => void | Promise<void>
  }): Promise<PositionBootstrapMonitorReport>
}

/** Ladder monitor required by the combined quoter-bot lifecycle. */
export interface QuoterBotLadderMonitor {
  /**
   * Monitors ladder reconciliations and cleans owned offers after shutdown.
   * @param parameters - Shared signal, cycle observer, and optional verbose submission observer.
   * @returns A sanitized terminal ladder-monitor report after cleanup.
   * @throws When monitor configuration is invalid before cleanup ownership is established.
   */
  runContinuously(parameters: {
    signal: AbortSignal
    onCycle?: (results: readonly { status: string }[]) => void | Promise<void>
    runOperation?: MonitorOperationQueue
    verbose?: boolean
    onTransactionSubmitted?: (event: LadderTransactionSubmittedEvent) => void | Promise<void>
  }): Promise<LadderMonitorReport>
}

/** One fulfilled workflow report or sanitized rejected-workflow classification. */
export type QuoterBotWorkflowOutcome<Report> =
  | { status: 'fulfilled'; report: Report }
  | { status: 'rejected'; errorName: string }

/** Tagged JSON event emitted by one workflow within the combined lifecycle. */
export type QuoterBotEvent =
  | { event: 'quoter-bot.cycle'; workflow: 'setup-check'; report: SetupCheckReport }
  | {
      event: 'quoter-bot.cycle'
      workflow: 'bootstrap'
      results: readonly { status: string; [key: string]: unknown }[]
    }
  | {
      event: 'quoter-bot.cycle'
      workflow: 'ladder'
      results: readonly { status: string }[]
    }
  | BootstrapTransactionSubmittedEvent
  | LadderTransactionSubmittedEvent

/** Final combined lifecycle report after every workflow and cleanup has settled. */
export type QuoterBotMonitorReport = {
  /** Whether the operator requested a clean stop or one workflow ended unexpectedly. */
  status: 'stopped' | 'halted'
  /** Stable reason for the combined terminal state. */
  reason: 'signal' | 'workflow-halted' | 'workflow-error' | 'workflow-stopped'
  /** Terminal outcomes retained for each concurrently started workflow. */
  workflows: {
    setupCheck: QuoterBotWorkflowOutcome<SetupCheckMonitorReport>
    bootstrap: QuoterBotWorkflowOutcome<PositionBootstrapMonitorReport>
    ladder: QuoterBotWorkflowOutcome<LadderMonitorReport>
  }
}

/** Supervises setup, bootstrap, and ladder monitors as one fail-together lifecycle. */
export class QuoterBotService {
  /**
   * Creates the combined quoter-bot monitor.
   * @param setup - Read-only readiness monitor.
   * @param bootstrap - Position-bootstrap monitor with owned-offer cleanup.
   * @param ladder - Ladder monitor with owned-offer cleanup.
   */
  constructor(
    private readonly setup: QuoterBotSetupMonitor,
    private readonly bootstrap: QuoterBotBootstrapMonitor,
    private readonly ladder: QuoterBotLadderMonitor
  ) {}

  /**
   * Runs all three monitors concurrently and stops the peers after any terminal outcome.
   * @param parameters - Operator signal, tagged event observer, and verbose writer diagnostics.
   * @returns A combined report only after bootstrap and ladder shutdown cleanup have settled.
   * @remarks Writer workflows share one queue around each full read-decision-write cycle and
   * cleanup. A handled cycle failure aborts peers before releasing that queue, while a rejection is
   * reduced to an allowlisted name and cleanup still drains before the combined report resolves.
   */
  async runContinuously(parameters: {
    signal: AbortSignal
    onEvent?: (event: QuoterBotEvent) => void | Promise<void>
    verbose?: boolean
  }): Promise<QuoterBotMonitorReport> {
    const controller = new AbortController()
    let stopRequested = parameters.signal.aborted
    let workflowSettledBeforeOperator = false
    const stopFromOperator = () => {
      stopRequested = true
      controller.abort()
    }
    const stopFromWorkflow = () => {
      if (!stopRequested) workflowSettledBeforeOperator = true
      controller.abort()
    }
    const operationQueue = createOperationQueue()
    const runOperation: MonitorOperationQueue = operation =>
      operationQueue(async () => {
        try {
          return await operation()
        } catch (error) {
          stopFromWorkflow()
          throw error
        }
      })

    if (stopRequested) controller.abort()
    parameters.signal.addEventListener('abort', stopFromOperator, { once: true })

    const setupMonitor = Promise.resolve()
      .then(() =>
        this.setup.runContinuously({
          signal: controller.signal,
          onCycle: async report => {
            if (!report.ready) stopFromWorkflow()
            await parameters.onEvent?.({
              event: 'quoter-bot.cycle',
              workflow: 'setup-check',
              report
            })
          }
        })
      )
      .finally(stopFromWorkflow)
    const bootstrapMonitor = Promise.resolve()
      .then(() =>
        this.bootstrap.runContinuously({
          signal: controller.signal,
          onCycle: async results => {
            await parameters.onEvent?.({
              event: 'quoter-bot.cycle',
              workflow: 'bootstrap',
              results
            })
            if (cycleHasFailure(results)) stopFromWorkflow()
          },
          runOperation,
          verbose: parameters.verbose,
          onTransactionSubmitted:
            parameters.verbose === true ? event => parameters.onEvent?.(event) : undefined
        })
      )
      .finally(stopFromWorkflow)
    const ladderMonitor = Promise.resolve()
      .then(() =>
        this.ladder.runContinuously({
          signal: controller.signal,
          onCycle: async results => {
            await parameters.onEvent?.({
              event: 'quoter-bot.cycle',
              workflow: 'ladder',
              results
            })
            if (cycleHasFailure(results)) stopFromWorkflow()
          },
          runOperation,
          verbose: parameters.verbose,
          onTransactionSubmitted:
            parameters.verbose === true ? event => parameters.onEvent?.(event) : undefined
        })
      )
      .finally(stopFromWorkflow)

    const [setupSettlement, bootstrapSettlement, ladderSettlement] = await Promise.allSettled([
      setupMonitor,
      bootstrapMonitor,
      ladderMonitor
    ])
    parameters.signal.removeEventListener('abort', stopFromOperator)

    const toOutcome = <Report>(
      settlement: PromiseSettledResult<Report>
    ): QuoterBotWorkflowOutcome<Report> =>
      settlement.status === 'fulfilled'
        ? { status: 'fulfilled', report: settlement.value }
        : { status: 'rejected', errorName: operatorErrorName(settlement.reason) }

    const workflows = {
      setupCheck: toOutcome(setupSettlement),
      bootstrap: toOutcome(bootstrapSettlement),
      ladder: toOutcome(ladderSettlement)
    }
    const outcomes = Object.values(workflows)
    const workflowRejected = outcomes.some(outcome => outcome.status === 'rejected')
    const workflowHalted = outcomes.some(
      outcome => outcome.status === 'fulfilled' && outcome.report.status === 'halted'
    )

    if (workflowRejected) return { status: 'halted', reason: 'workflow-error', workflows }
    if (workflowHalted) return { status: 'halted', reason: 'workflow-halted', workflows }
    if (workflowSettledBeforeOperator) {
      return { status: 'halted', reason: 'workflow-stopped', workflows }
    }
    return { status: 'stopped', reason: 'signal', workflows }
  }
}
