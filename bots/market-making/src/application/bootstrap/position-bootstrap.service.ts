import type { Hex } from 'viem'

import type {
  BootstrapConfig,
  BootstrapOffer,
  BootstrapPosition,
  BootstrapRate,
  PositionBootstrapDecision
} from '../../domain/bootstrap/position-bootstrap'
import type {
  BootstrapMakeResult,
  BootstrapSubmittedTransaction,
  BootstrapTransactionSubmittedEvent,
  BootstrapTransactionSubmittedObserver,
  BootstrapVerboseDetails,
  BootstrapVerbosePosition,
  BootstrapVerboseState
} from './position-bootstrap-verbose'

import { BootstrapConfigurationError } from '../../domain/bootstrap/bootstrap-configuration.error'
import {
  decidePositionBootstrap,
  decidePositionBootstrapTransition,
  validateBootstrapConfig
} from '../../domain/bootstrap/position-bootstrap'
import { waitForMonitorInterval } from '../monitor.utils'
import { operatorErrorDetails, operatorErrorName } from '../operator-error-name.utils'
import { bootstrapCycleHasFailure } from './position-bootstrap-monitor.utils'

const BOOTSTRAP_MONITOR_INTERVAL_MS = 60_000

type DecisionInvalidationReason = Extract<
  PositionBootstrapDecision,
  { kind: 'invalidate' }
>['reason']

type FailedInvalidationContext =
  | { stage: 'position-read'; error: unknown }
  | { stage: 'make'; reason: DecisionInvalidationReason }

/** Port for reading the fresh chain position and active bootstrap offer for one market. */
export interface BootstrapPositionService {
  /**
   * Reads the complete position state required for one bootstrap decision.
   * @param marketId - Canonical market identifier to inspect.
   * @returns Fresh credit, debt, capacity inputs, any representative active bootstrap offer, and a
   *   reconciliation marker when duplicate groups exist.
   * @throws Error when the position provider cannot return a fresh, valid snapshot.
   * @remarks This read-only port must not publish, replace, or invalidate offers.
   */
  readPosition(marketId: Hex): Promise<
    BootstrapPosition & {
      debt: bigint
      activeOffer?: BootstrapOffer
      requiresReconciliation?: boolean
    }
  >
}

/** Port for reading a stable reference-rate observation for one bootstrap market. */
export interface BootstrapReferenceRateService {
  /**
   * Reads the current reference rate used to derive a requested bootstrap rate.
   * @param marketId - Canonical market identifier whose reference is required.
   * @returns Static or variable rate and its stable observation identifier.
   * @throws Error when the reference provider cannot return a fresh, valid observation.
   * @remarks This read-only port must not publish, replace, or invalidate offers.
   */
  readRate(marketId: Hex): Promise<BootstrapRate>
}

/** Port for reconciling market offers and invalidating the complete bootstrap strategy. */
export interface BootstrapMakeService {
  /**
   * Reconciles one market's desired bootstrap offer or invalidates that market group.
   * @param parameters - Canonical market, optional desired offer, and stable action reason.
   * @returns `logged` for a dry-run, or confirmed transaction hashes for a live reconciliation.
   * @throws Error when simulation, publication, replacement, or invalidation fails.
   * @remarks Live adapters may change only the requested strategy-owned market group. Dry-run
   * adapters must return `logged` after recording the same request without mutation.
   */
  reconcile(parameters: {
    marketId: Hex
    desiredOffer?: BootstrapOffer
    reason:
      | 'publish'
      | 'replace'
      | 'target-reached'
      | 'no-capacity'
      | 'auto-refill-disabled'
      | 'market-read-failed'
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  }): Promise<BootstrapMakeResult>
  /**
   * Invalidates all strategy-owned bootstrap groups after a cycle-level safety failure.
   * @param parameters - Fixed safety reason that triggered strategy-wide invalidation.
   * @returns `logged` for a dry-run, or confirmed cancellation hashes for a live hard halt.
   * @throws Error when one or more strategy-owned groups cannot be invalidated.
   * @remarks Live adapters perform strategy-wide cleanup and must not publish offers. Dry-run
   * adapters return `logged` without claiming cleanup occurred.
   */
  hardHalt(parameters: {
    reason:
      | 'reference-read-failed'
      | 'bootstrap-decision-failed'
      | 'bootstrap-configuration-failed'
      | 'market-invalidation-failed'
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  }): Promise<BootstrapMakeResult>
  /**
   * Invalidates every strategy-owned bootstrap group during graceful monitoring shutdown.
   * @param parameters - Optional transaction-submission observer for verbose operator output.
   * @returns `logged` for a dry-run, or confirmed cancellation hashes for live cleanup.
   * @throws Error when one or more strategy-owned groups cannot be invalidated.
   * @remarks Live adapters must serialize cleanup behind any in-flight mutation. Dry-run adapters
   * record the same request without signing or invalidating.
   */
  cleanup(parameters?: {
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  }): Promise<BootstrapMakeResult>
}

type BootstrapRunOutcome =
  | {
      marketId: Hex
      status: 'observed'
      action: 'target-reached' | 'auto-refill-disabled' | 'no-capacity' | 'rest'
    }
  | {
      marketId: Hex
      status: 'applied' | 'logged'
      action: 'invalidate' | 'publish' | 'replace'
    }
  | {
      marketId: Hex
      status: 'failed'
      stage: 'position-read' | 'make'
      invalidated: boolean
      invalidationLogged?: boolean
      errorName: string
      minimumAssets?: string
      invalidationErrorName?: string
    }
  | {
      marketId: Hex
      status: 'halted'
      stage: 'configuration' | 'reference-read' | 'decision'
      strategyInvalidated: boolean
      strategyInvalidationLogged?: boolean
      errorName: string
      invalidationErrorName?: string
    }
  | {
      marketId: Hex
      status: 'halted'
      stage: 'position-read'
      strategyInvalidated: boolean
      strategyInvalidationLogged?: boolean
      errorName: string
      invalidationErrorName: string
      hardHaltErrorName?: string
    }
  | {
      marketId: Hex
      status: 'halted'
      stage: 'make'
      action: 'invalidate'
      reason: DecisionInvalidationReason
      strategyInvalidated: boolean
      strategyInvalidationLogged?: boolean
      invalidationErrorName: string
      hardHaltErrorName?: string
    }

/** Sanitized outcome for one configured market in a bootstrap cycle. */
export type BootstrapRunResult = BootstrapRunOutcome & {
  /** Opt-in configuration, decision, transaction, and before/after position diagnostics. */
  verbose?: BootstrapVerboseDetails
}

type BootstrapVerbosePlan = Omit<BootstrapVerboseDetails, 'stateAfterCheck'>

type BootstrapRunPlan =
  | {
      config: BootstrapConfig
      decision: PositionBootstrapDecision
      verbose?: BootstrapVerbosePlan
    }
  | { result: BootstrapRunResult }

type BootstrapMutationOutcome = {
  result: BootstrapRunOutcome
  makeResult?: BootstrapMakeResult
}

/** Final lifecycle report emitted after continuous bootstrap monitoring stops. */
export type PositionBootstrapMonitorReport = {
  /** Whether shutdown completed normally or monitoring halted on a cycle/cleanup failure. */
  status: 'stopped' | 'halted'
  /** Stable reason for the terminal monitor state. */
  reason: 'signal' | 'cycle-failed' | 'cycle-error' | 'cleanup-failed'
  /** Number of complete cycles emitted to the monitoring writer. */
  cycles: number
  /** Strategy-owned cleanup outcome after the final in-flight cycle completed. */
  cleanup: {
    status: 'applied' | 'logged' | 'failed'
    errorName?: string
    /** Confirmed cleanup cancellations, included only for verbose monitoring. */
    submittedTransactions?: readonly BootstrapSubmittedTransaction[]
  }
  /** Last handled failed cycle, retained only when it caused the halt. */
  lastCycle?: readonly BootstrapRunResult[]
  /** Sanitized unexpected cycle or output-writer error classification. */
  cycleErrorName?: string
}

/** Coordinates live or logged position-bootstrap cycles through explicit make-port outcomes. */
export class PositionBootstrapService {
  private readonly completedMarkets = new Set<Hex>()

  /**
   * Creates a bootstrap coordinator around injected read and publication ports.
   * @param positions - Fresh position and active-offer reader.
   * @param rates - Reference-rate observation reader.
   * @param make - Market reconciliation and strategy hard-halt writer.
   * @param configs - Ordered validated-at-runtime market strategies.
   */
  constructor(
    private readonly positions: BootstrapPositionService,
    private readonly rates: BootstrapReferenceRateService,
    private readonly make: BootstrapMakeService,
    private readonly configs: readonly BootstrapConfig[]
  ) {}

  /**
   * Repeats complete bootstrap observations until shutdown, then invalidates owned bootstrap groups.
   * @param parameters - Shutdown signal, optional cycle writer, testable interval, and verbose flag.
   * @returns A terminal report after cleanup has been attempted.
   * @throws `BootstrapConfigurationError` before any cleanup when no bootstrap market is configured.
   * @remarks Each cycle finishes before shutdown cleanup begins. Cycles never overlap, every
   * completed result is emitted once, and cleanup is serialized through the make port. Verbose
   * cycles perform a second read per market after each check and expose only safe operational data.
   */
  async runContinuously(parameters: {
    signal: AbortSignal
    onCycle?: (results: readonly Record<string, unknown>[]) => void | Promise<void>
    intervalMs?: number
    verbose?: boolean
    onTransactionSubmitted?: (event: BootstrapTransactionSubmittedEvent) => void | Promise<void>
  }): Promise<PositionBootstrapMonitorReport> {
    if (this.configs.length === 0) {
      throw new BootstrapConfigurationError(
        'bootstrap',
        'requires at least one configured market for monitoring'
      )
    }

    const intervalMs = parameters.intervalMs ?? BOOTSTRAP_MONITOR_INTERVAL_MS
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new BootstrapConfigurationError(
        'bootstrap monitor interval',
        'must be a positive safe integer'
      )
    }

    let cycles = 0
    let reason: PositionBootstrapMonitorReport['reason'] = 'signal'
    let lastCycle: readonly BootstrapRunResult[] | undefined
    let cycleErrorName: string | undefined

    while (!parameters.signal.aborted) {
      let results: readonly BootstrapRunResult[]
      try {
        results = await this.runOnce({
          verbose: parameters.verbose,
          onTransactionSubmitted: parameters.onTransactionSubmitted
        })
        cycles += 1
        await parameters.onCycle?.(results)
      } catch (error) {
        reason = 'cycle-error'
        cycleErrorName = operatorErrorName(error)
        break
      }

      if (bootstrapCycleHasFailure(results)) {
        reason = 'cycle-failed'
        lastCycle = results
        break
      }

      await waitForMonitorInterval(intervalMs, parameters.signal)
    }

    let cleanup: PositionBootstrapMonitorReport['cleanup']
    try {
      const result = await this.cleanup({
        onTransactionSubmitted:
          parameters.verbose && parameters.onTransactionSubmitted
            ? transaction =>
                parameters.onTransactionSubmitted?.({
                  event: 'bootstrap.transaction-submitted',
                  ...transaction
                })
            : undefined
      })
      cleanup = {
        status: result === 'logged' ? 'logged' : 'applied',
        ...(parameters.verbose ? { submittedTransactions: this.submittedTransactions(result) } : {})
      }
    } catch (error) {
      cleanup = { status: 'failed', errorName: operatorErrorName(error) }
      reason = 'cleanup-failed'
    }

    return {
      status: reason === 'signal' ? 'stopped' : 'halted',
      reason,
      cycles,
      cleanup,
      ...(lastCycle ? { lastCycle } : {}),
      ...(cycleErrorName ? { cycleErrorName } : {})
    }
  }

  /**
   * Invalidates every strategy-owned bootstrap group after monitoring stops.
   * @param parameters - Optional transaction-submission observer for verbose operator output.
   * @returns `logged` for read-only cleanup or confirmed hashes after live invalidations.
   * @throws Error when the make adapter cannot complete exhaustive strategy cleanup.
   * @remarks Cleanup is serialized behind any in-flight publication, replacement, or invalidation.
   */
  cleanup(
    parameters: {
      onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
    } = {}
  ) {
    return this.make.cleanup(parameters)
  }

  /**
   * Validates all configured markets, then applies one fresh bootstrap cycle per market.
   * @param parameters - Optional verbose flag for safe before/after state and transaction details.
   * @returns Ordered market outcomes; dry-run make requests are `logged`, never `applied`.
   * @throws Never for handled provider, configuration, or make failures; their classifications and
   *   cleanup evidence are returned in the structured result.
   * @remarks Invalid configuration hard-halts before any position/reference read or publication.
   * Verbose mode adds a fresh post-check read without exposing signer identity or provider details.
   */
  async runOnce(
    parameters: {
      verbose?: boolean
      onTransactionSubmitted?: (event: BootstrapTransactionSubmittedEvent) => void | Promise<void>
    } = {}
  ) {
    const verbose = parameters.verbose === true
    const results: BootstrapRunResult[] = []
    for (const config of this.configs) {
      try {
        validateBootstrapConfig(config)
      } catch (error) {
        const halt = await this.haltStrategy(
          config.marketId,
          'configuration',
          error,
          'bootstrap-configuration-failed',
          this.transactionObserver(parameters, verbose)
        )
        const submittedTransactions = this.submittedTransactions(halt.makeResult)
        results.push(
          verbose
            ? {
                ...halt.result,
                verbose: {
                  config,
                  currentState: {
                    status: 'not-read',
                    reason: 'configuration-invalid'
                  },
                  ...(submittedTransactions.length > 0 ? { submittedTransactions } : {}),
                  stateAfterCheck: {
                    status: 'not-read',
                    reason: 'configuration-invalid'
                  }
                }
              }
            : halt.result
        )
        return results
      }
    }

    const plans: BootstrapRunPlan[] = []
    const preflightResults = () => plans.flatMap(plan => ('result' in plan ? [plan.result] : []))
    let reservedAssetsDelta = 0n
    const reservedAssetsDeltaByMarket = new Map<Hex, bigint>()

    for (const config of this.configs) {
      let observedPosition: Awaited<ReturnType<BootstrapPositionService['readPosition']>>
      try {
        observedPosition = await this.positions.readPosition(config.marketId)
      } catch (error) {
        const failure = await this.failedMarketRead(
          config.marketId,
          'position-read',
          error,
          'market-read-failed',
          this.transactionObserver(parameters, verbose, config.marketId),
          this.transactionObserver(parameters, verbose)
        )
        const completedResult = await this.withVerboseDetails(
          failure.result,
          verbose,
          {
            config,
            currentState: {
              status: 'failed',
              errorName: operatorErrorName(error)
            }
          },
          true,
          failure.makeResult
        )
        if (failure.result.status === 'halted') {
          return [...preflightResults(), completedResult]
        }
        plans.push({ result: completedResult })
        continue
      }
      const currentState = this.verbosePosition(config.marketId, observedPosition)
      const marketReservationDelta = reservedAssetsDeltaByMarket.get(config.marketId) ?? 0n
      const position = {
        ...observedPosition,
        cashBalance:
          reservedAssetsDelta >= 0n
            ? observedPosition.cashBalance > reservedAssetsDelta
              ? observedPosition.cashBalance - reservedAssetsDelta
              : 0n
            : observedPosition.cashBalance - reservedAssetsDelta,
        marketExposure:
          marketReservationDelta >= 0n
            ? observedPosition.marketExposure + marketReservationDelta
            : observedPosition.marketExposure > -marketReservationDelta
              ? observedPosition.marketExposure + marketReservationDelta
              : 0n,
        totalExposure:
          reservedAssetsDelta >= 0n
            ? observedPosition.totalExposure + reservedAssetsDelta
            : observedPosition.totalExposure > -reservedAssetsDelta
              ? observedPosition.totalExposure + reservedAssetsDelta
              : 0n
      }
      const effectiveState = this.verbosePosition(config.marketId, position)

      let transition: ReturnType<typeof decidePositionBootstrapTransition>
      try {
        transition = decidePositionBootstrapTransition({
          config,
          position,
          activeOffer: position.activeOffer,
          initialTargetCompleted: this.completedMarkets.has(config.marketId)
        })
      } catch (error) {
        const halt = await this.haltStrategy(
          config.marketId,
          'decision',
          error,
          'bootstrap-decision-failed',
          this.transactionObserver(parameters, verbose)
        )
        return [
          ...preflightResults(),
          await this.withVerboseDetails(
            halt.result,
            verbose,
            {
              config,
              currentState: { status: 'observed', position: currentState },
              effectiveState
            },
            true,
            halt.makeResult
          )
        ]
      }
      let decision: PositionBootstrapDecision
      let rate: BootstrapRate | undefined

      if (transition) {
        decision = transition
      } else {
        try {
          rate = await this.rates.readRate(config.marketId)
        } catch (error) {
          const halt = await this.haltStrategy(
            config.marketId,
            'reference-read',
            error,
            'reference-read-failed',
            this.transactionObserver(parameters, verbose)
          )
          return [
            ...preflightResults(),
            await this.withVerboseDetails(
              halt.result,
              verbose,
              {
                config,
                currentState: { status: 'observed', position: currentState },
                effectiveState
              },
              true,
              halt.makeResult
            )
          ]
        }

        try {
          decision = decidePositionBootstrap({
            config,
            position,
            rate,
            activeOffer: position.activeOffer,
            requiresReconciliation: position.requiresReconciliation,
            initialTargetCompleted: this.completedMarkets.has(config.marketId)
          })
        } catch (error) {
          const halt = await this.haltStrategy(
            config.marketId,
            'decision',
            error,
            'bootstrap-decision-failed',
            this.transactionObserver(parameters, verbose)
          )
          return [
            ...preflightResults(),
            await this.withVerboseDetails(
              halt.result,
              verbose,
              {
                config,
                currentState: { status: 'observed', position: currentState },
                effectiveState,
                referenceRate: rate,
                targetRateBps: rate.rateBps + config.premiumBps
              },
              true,
              halt.makeResult
            )
          ]
        }
      }

      plans.push({
        config,
        decision,
        ...(verbose
          ? {
              verbose: {
                config,
                currentState: { status: 'observed' as const, position: currentState },
                effectiveState,
                ...(rate
                  ? {
                      referenceRate: rate,
                      targetRateBps: rate.rateBps + config.premiumBps
                    }
                  : {}),
                decision,
                ...('offer' in decision ? { bootstrapOffer: decision.offer } : {})
              }
            }
          : {})
      })
      if (decision.kind === 'publish' || decision.kind === 'replace') {
        const replacedAssets =
          decision.kind === 'replace' ? (position.activeOffer?.assets ?? 0n) : 0n
        const exposureDelta = decision.offer.assets - replacedAssets
        reservedAssetsDelta += exposureDelta
        reservedAssetsDeltaByMarket.set(config.marketId, marketReservationDelta + exposureDelta)
      } else if (decision.kind === 'invalidate' && position.activeOffer) {
        const exposureDelta = -position.activeOffer.assets
        reservedAssetsDelta += exposureDelta
        reservedAssetsDeltaByMarket.set(config.marketId, marketReservationDelta + exposureDelta)
      }
    }

    for (const plan of plans) {
      if ('result' in plan) {
        results.push(plan.result)
        continue
      }
      const { config, decision } = plan

      if ('completesInitialTarget' in decision && decision.completesInitialTarget) {
        this.completedMarkets.add(config.marketId)
      }

      if (decision.kind === 'target-reached') {
        results.push(
          await this.withVerboseDetails(
            {
              marketId: config.marketId,
              status: 'observed' as const,
              action: 'target-reached' as const
            },
            verbose,
            plan.verbose
          )
        )
        continue
      }
      if (decision.kind === 'observe') {
        results.push(
          await this.withVerboseDetails(
            {
              marketId: config.marketId,
              status: 'observed' as const,
              action: decision.reason
            },
            verbose,
            plan.verbose
          )
        )
        continue
      }
      if (decision.kind === 'rest') {
        results.push(
          await this.withVerboseDetails(
            {
              marketId: config.marketId,
              status: 'observed' as const,
              action: 'rest' as const
            },
            verbose,
            plan.verbose
          )
        )
        continue
      }
      if (decision.kind === 'invalidate') {
        let reconciliation: BootstrapMakeResult
        try {
          reconciliation = await this.make.reconcile({
            marketId: config.marketId,
            desiredOffer: undefined,
            reason: decision.reason,
            onTransactionSubmitted: this.transactionObserver(parameters, verbose, config.marketId)
          })
        } catch (error) {
          const halt = await this.haltAfterInvalidationFailure(
            config.marketId,
            { stage: 'make', reason: decision.reason },
            error,
            this.transactionObserver(parameters, verbose)
          )
          results.push(
            await this.withVerboseDetails(halt.result, verbose, plan.verbose, true, halt.makeResult)
          )
          return results
        }
        results.push(
          await this.withVerboseDetails(
            {
              marketId: config.marketId,
              status: reconciliation === 'logged' ? ('logged' as const) : ('applied' as const),
              action: 'invalidate' as const
            },
            verbose,
            plan.verbose,
            false,
            reconciliation
          )
        )
        continue
      }

      let reconciliation: BootstrapMakeResult
      try {
        reconciliation = await this.make.reconcile({
          marketId: config.marketId,
          desiredOffer: decision.offer,
          reason: decision.kind,
          onTransactionSubmitted: this.transactionObserver(parameters, verbose, config.marketId)
        })
      } catch (error) {
        results.push(
          await this.withVerboseDetails(
            {
              marketId: config.marketId,
              status: 'failed' as const,
              stage: 'make' as const,
              invalidated: false,
              ...operatorErrorDetails(error)
            },
            verbose,
            plan.verbose,
            true
          )
        )
        return results
      }
      results.push(
        await this.withVerboseDetails(
          {
            marketId: config.marketId,
            status: reconciliation === 'logged' ? ('logged' as const) : ('applied' as const),
            action: decision.kind
          },
          verbose,
          plan.verbose,
          false,
          reconciliation
        )
      )
    }
    return results
  }

  private async failedMarketRead(
    marketId: Hex,
    stage: 'position-read',
    readError: unknown,
    reason: 'market-read-failed',
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver,
    onHardHaltTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  ): Promise<BootstrapMutationOutcome> {
    try {
      const reconciliation = await this.make.reconcile({
        marketId,
        desiredOffer: undefined,
        reason,
        onTransactionSubmitted
      })
      return {
        result: {
          marketId,
          status: 'failed' as const,
          stage,
          invalidated: reconciliation !== 'logged',
          ...(reconciliation === 'logged' ? { invalidationLogged: true } : {}),
          errorName: operatorErrorName(readError)
        },
        makeResult: reconciliation
      }
    } catch (invalidationError) {
      return this.haltAfterInvalidationFailure(
        marketId,
        { stage, error: readError },
        invalidationError,
        onHardHaltTransactionSubmitted
      )
    }
  }

  private async haltAfterInvalidationFailure(
    marketId: Hex,
    context: FailedInvalidationContext,
    invalidationError: unknown,
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  ): Promise<BootstrapMutationOutcome> {
    let hardHaltError: unknown
    let hardHaltResult: BootstrapMakeResult = undefined
    try {
      hardHaltResult = await this.make.hardHalt({
        reason: 'market-invalidation-failed',
        onTransactionSubmitted
      })
    } catch (error) {
      hardHaltError = error
    }
    const strategyInvalidated = hardHaltError === undefined && hardHaltResult !== 'logged'
    let cleanupFailure: {
      hardHaltErrorName?: string
      strategyInvalidationLogged?: true
    } = {}
    if (hardHaltError !== undefined) {
      cleanupFailure = { hardHaltErrorName: operatorErrorName(hardHaltError) }
    } else if (hardHaltResult === 'logged') {
      cleanupFailure = { strategyInvalidationLogged: true }
    }
    if (context.stage === 'position-read') {
      return {
        result: {
          marketId,
          status: 'halted' as const,
          stage: context.stage,
          strategyInvalidated,
          errorName: operatorErrorName(context.error),
          invalidationErrorName: operatorErrorName(invalidationError),
          ...cleanupFailure
        },
        ...(hardHaltError === undefined ? { makeResult: hardHaltResult } : {})
      }
    }
    return {
      result: {
        marketId,
        status: 'halted' as const,
        stage: context.stage,
        action: 'invalidate' as const,
        reason: context.reason,
        strategyInvalidated,
        invalidationErrorName: operatorErrorName(invalidationError),
        ...cleanupFailure
      },
      ...(hardHaltError === undefined ? { makeResult: hardHaltResult } : {})
    }
  }

  private async haltStrategy(
    marketId: Hex,
    stage: 'configuration' | 'reference-read' | 'decision',
    failure: unknown,
    reason:
      | 'reference-read-failed'
      | 'bootstrap-decision-failed'
      | 'bootstrap-configuration-failed',
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  ): Promise<BootstrapMutationOutcome> {
    try {
      const invalidation = await this.make.hardHalt({ reason, onTransactionSubmitted })
      return {
        result: {
          marketId,
          status: 'halted' as const,
          stage,
          strategyInvalidated: invalidation !== 'logged',
          ...(invalidation === 'logged' ? { strategyInvalidationLogged: true } : {}),
          errorName: operatorErrorName(failure)
        },
        makeResult: invalidation
      }
    } catch (invalidationError) {
      return {
        result: {
          marketId,
          status: 'halted' as const,
          stage,
          strategyInvalidated: false,
          errorName: operatorErrorName(failure),
          invalidationErrorName: operatorErrorName(invalidationError)
        }
      }
    }
  }

  private verbosePosition(
    marketId: Hex,
    position: Awaited<ReturnType<BootstrapPositionService['readPosition']>>
  ): BootstrapVerbosePosition {
    return {
      credit: position.credit,
      debt: position.debt,
      cashBalance: position.cashBalance,
      marketExposure: position.marketExposure,
      totalExposure: position.totalExposure,
      ...(position.activeOffer ? { activeOffer: position.activeOffer } : {}),
      requiresReconciliation: position.requiresReconciliation === true,
      initialTargetCompleted: this.completedMarkets.has(marketId)
    }
  }

  private async readVerboseState(marketId: Hex): Promise<BootstrapVerboseState> {
    try {
      return {
        status: 'observed',
        position: this.verbosePosition(marketId, await this.positions.readPosition(marketId))
      }
    } catch (error) {
      return { status: 'failed', errorName: operatorErrorName(error) }
    }
  }

  private async withVerboseDetails(
    result: BootstrapRunOutcome,
    verbose: boolean,
    details?: BootstrapVerbosePlan,
    forceStateRead = false,
    makeResult?: BootstrapMakeResult
  ): Promise<BootstrapRunResult> {
    if (!verbose || !details) return result
    const submittedTransactions = this.submittedTransactions(makeResult)
    return {
      ...result,
      verbose: {
        ...details,
        ...(submittedTransactions.length > 0 ? { submittedTransactions } : {}),
        stateAfterCheck:
          forceStateRead || details.currentState.status !== 'not-read'
            ? await this.readVerboseState(result.marketId)
            : details.currentState
      }
    }
  }

  private submittedTransactions(
    result: BootstrapMakeResult
  ): readonly BootstrapSubmittedTransaction[] {
    return result && result !== 'logged' ? result.submittedTransactions : []
  }

  private transactionObserver(
    parameters: {
      onTransactionSubmitted?: (event: BootstrapTransactionSubmittedEvent) => void | Promise<void>
    },
    verbose: boolean,
    marketId?: Hex
  ): BootstrapTransactionSubmittedObserver | undefined {
    if (!verbose || !parameters.onTransactionSubmitted) return undefined
    return transaction =>
      parameters.onTransactionSubmitted?.({
        event: 'bootstrap.transaction-submitted',
        ...(marketId ? { marketId } : {}),
        ...transaction
      })
  }
}
