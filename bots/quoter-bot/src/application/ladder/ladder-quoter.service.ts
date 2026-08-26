import type { MonitorOperationQueue } from '@repo/monitoring'
import type { Hex } from 'viem'

import { cycleHasFailure, waitForMonitorInterval } from '@repo/monitoring'

import type {
  LadderConfig,
  LadderDiagnostics,
  LadderMarketState,
  LadderQuoteSet
} from '../../domain/ladder/ladder'
import type {
  LadderGroupConsumption,
  LadderMakeResult,
  LadderSubmittedTransaction,
  LadderTransactionSubmittedEvent,
  LadderTransactionSubmittedObserver,
  LadderVerboseDetails,
  LadderVerboseState
} from './ladder-verbose'

import {
  generateLadderWithDiagnostics,
  shouldRecenter,
  validateLadderConfig
} from '../../domain/ladder/ladder'
import { LadderConfigurationError } from '../../domain/ladder/ladder-configuration.error'
import { LadderAdapterError } from '../../infrastructure/ladder/ladder-adapter.error'
import { operatorErrorName } from '../operator-error-name.utils'
import { LadderOwnershipCleanupError } from './ladder-ownership-cleanup.error'
import { sameLadderQuoteSet } from './ladder-quoter.utils'

/** Consumer-owned port for fresh position and capacity inputs for one ladder market. */
export interface LadderPositionService {
  /**
   * Reads current side, market, and total capacities.
   * @param marketId - Canonical market identifier to inspect.
   * @returns Fresh capacities used to resize both sides before reconciliation.
   * @throws When the position provider cannot return a complete current market snapshot.
   */
  readMarket(marketId: Hex): Promise<LadderMarketState>
}

/** Consumer-owned port for the current reference rate of one ladder market. */
export interface LadderReferenceRateService {
  /**
   * Reads the current fixed-point reference rate.
   * @param marketId - Canonical market identifier whose reference is required.
   * @returns Current rate in integer basis points.
   * @throws When the rate provider cannot return a fresh valid reference.
   */
  readRate(marketId: Hex): Promise<bigint>
  /**
   * Optionally reads the rate together with a freshness identity used to refresh timestamp-sensitive
   * protocol offers even when the configured APR is unchanged.
   * @param marketId - Canonical market identifier whose reference is required.
   * @returns Current rate and stable freshness observation identity.
   * @throws When the rate provider cannot return a fresh valid reference.
   */
  readObservation?(marketId: Hex): Promise<{ rateBps: bigint; observationId: string }>
}

/** Consumer-owned blocking make boundary for ladder reconciliation and safety invalidation. */
export interface LadderMakeService {
  /**
   * Invalidates durable strategy groups whose markets are no longer configured.
   * @returns Indexed canceled group IDs that readiness must ignore until indexer tombstones disappear.
   * @throws When ownership cannot be read or complete cancellation cannot be confirmed.
   * @remarks Implementations must be idempotent; composition may invoke this before readiness and
   * again when a cycle starts. Read-only implementations may omit the operation.
   */
  cleanupRemovedMarkets?(): Promise<readonly Hex[] | void>
  /**
   * Reads the currently active strategy-owned quote set from live book truth.
   * @param marketId - Canonical market identifier whose active roots must be reconstructed.
   * @returns Exact active quote set, or `undefined` when no strategy roots remain live.
   * @throws When active roots cannot be loaded or decoded safely.
   */
  readActive(marketId: Hex): Promise<LadderQuoteSet | undefined>
  /**
   * Reads the active quote and its groups' consumption from one snapshot.
   * @param marketId - Canonical market identifier whose active roots must be reconstructed.
   * @returns The active quote when roots remain live, and one consumption record per indexed owned
   * group; groups the indexer has not seen are omitted.
   * @throws When active roots cannot be loaded or decoded safely.
   * @remarks Optional; an adapter that cannot report consumption omits it, which only suppresses
   * fill telemetry. Both values must come from a SINGLE provider read: deriving them from separate
   * reads would put a monitoring round trip on the quoting path. Consumption is monotonic per group
   * ID, so cycle-over-cycle growth is taker fills rather than the strategy's own cancel and
   * republish — and it must be sampled before reconciliation, which forgets replaced groups.
   */
  readActiveState?(
    marketId: Hex
  ): Promise<{ quote?: LadderQuoteSet; consumption: readonly LadderGroupConsumption[] }>
  /**
   * Reconciles one strategy-owned market quote set against fresh active roots.
   * @param parameters - Market, optional exact desired set, stable reason, and submission observer.
   * @returns `logged` for a dry-run, otherwise confirmed transaction hashes.
   * @throws When publication, replacement, or invalidation does not settle successfully.
   */
  reconcile(parameters: {
    marketId: Hex
    desired?: LadderQuoteSet
    reason: 'publish' | 'recenter' | 'resize' | 'rest' | 'market-read-failed'
    onTransactionSubmitted?: LadderTransactionSubmittedObserver
  }): Promise<LadderMakeResult>
  /**
   * Invalidates all strategy-owned roots after an unsafe cycle-level failure.
   * @param parameters - Stable safety reason and optional transaction-submission observer.
   * @returns `logged` for a dry-run, otherwise confirmed cancellation hashes.
   * @throws When complete strategy-root invalidation cannot be confirmed.
   */
  hardHalt(parameters: {
    reason:
      | 'ladder-configuration-failed'
      | 'reference-read-failed'
      | 'ladder-decision-failed'
      | 'market-invalidation-failed'
    onTransactionSubmitted?: LadderTransactionSubmittedObserver
  }): Promise<LadderMakeResult>
  /**
   * Invalidates every strategy-owned ladder group during graceful monitoring shutdown.
   * @param parameters - Optional transaction-submission observer for verbose operator output.
   * @returns `logged` for a dry-run, otherwise confirmed cancellation hashes.
   * @throws When complete strategy-root cleanup cannot be confirmed.
   * @remarks Live adapters serialize cleanup behind any in-flight ladder mutation.
   */
  cleanup(parameters?: {
    onTransactionSubmitted?: LadderTransactionSubmittedObserver
  }): Promise<LadderMakeResult>
}

type LadderRunOutcome =
  | { marketId: Hex; status: 'observed'; action: 'rest' }
  | {
      marketId: Hex
      status: 'applied' | 'logged'
      action: 'publish' | 'replace'
      reason: 'publish' | 'recenter' | 'resize'
    }
  | {
      marketId: Hex
      status: 'failed'
      stage: 'market-read'
      invalidated: boolean
      invalidationLogged?: boolean
      errorName: string
    }
  | {
      marketId: Hex
      status: 'failed'
      stage: 'reconcile'
      invalidated: boolean
      errorName: string
      ownershipCleanupErrorName?: string
    }
  | {
      marketId: Hex
      status: 'halted'
      stage: 'configuration' | 'reference-read' | 'decision' | 'market-invalidation'
      strategyInvalidated: boolean
      strategyInvalidationLogged?: boolean
      errorName: string
      marketInvalidationErrorName?: string
      invalidationErrorName?: string
    }

/** Sanitized outcome for one configured market in a ladder cycle. */
export type LadderRunResult = LadderRunOutcome & {
  /** Opt-in configuration, quote, transaction, and before/after state diagnostics. */
  verbose?: LadderVerboseDetails
}

/** Optional diagnostics and transaction-submission hooks for one ladder cycle. */
type LadderRunParameters = {
  /** Adds configuration, rates, quotes, transactions, and before/after state to each outcome. */
  verbose?: boolean
  /** Receives a safe event immediately after each transaction hash is returned. */
  onTransactionSubmitted?: (event: LadderTransactionSubmittedEvent) => void | Promise<void>
}

type LadderVerbosePlan = Omit<LadderVerboseDetails, 'stateAfterCheck'>

/** Final lifecycle report emitted after continuous ladder monitoring stops. */
export type LadderMonitorReport = {
  /** Whether shutdown completed normally or monitoring halted on a cycle/cleanup failure. */
  status: 'stopped' | 'halted'
  /** Stable reason for the terminal monitor state. */
  reason: 'signal' | 'cycle-failed' | 'cycle-error' | 'cleanup-failed'
  /** Number of complete ladder cycles emitted to the monitoring writer. */
  cycles: number
  /** Strategy-owned cleanup outcome after the final in-flight cycle completed. */
  cleanup: {
    status: 'applied' | 'logged' | 'failed'
    errorName?: string
    /** Confirmed cleanup cancellations, included only for verbose monitoring. */
    submittedTransactions?: readonly LadderSubmittedTransaction[]
  }
  /** Last handled failed cycle, retained only when it caused the halt. */
  lastCycle?: readonly LadderRunResult[]
  /** Sanitized unexpected cycle or output-writer error classification. */
  cycleErrorName?: string
}

/** Coordinates deterministic ladder decisions through fresh read and explicit make outcomes. */
export class LadderQuoterService {
  /**
   * Creates one ladder application coordinator.
   * @param positions - Fresh position/capacity reader.
   * @param rates - Fresh reference-rate reader.
   * @param make - Blocking reconciliation, hard-halt, and cleanup writer.
   * @param configs - Ordered per-market ladder configurations.
   */
  constructor(
    private readonly positions: LadderPositionService,
    private readonly rates: LadderReferenceRateService,
    private readonly make: LadderMakeService,
    private readonly configs: readonly LadderConfig[]
  ) {}

  /**
   * Repeats complete ladder observations until shutdown, then invalidates owned ladder groups.
   * @param parameters - Shutdown signal, optional cycle writer, test interval, and verbose hooks.
   * @returns A terminal report after cleanup has been attempted.
   * @throws `LadderConfigurationError` before cleanup when no market or interval is usable.
   * @remarks Cycles never overlap. Production cadence uses the shortest configured market interval;
   * a test-only `intervalMs` override applies to the complete configured set. Cleanup is serialized
   * through the make port after the final in-flight cycle. Verbose cycles perform a fresh
   * market/active-quote read after every check and emit submitted transaction hashes immediately.
   */
  async runContinuously(parameters: {
    signal: AbortSignal
    onCycle?: (results: readonly LadderRunResult[]) => void | Promise<void>
    runOperation?: MonitorOperationQueue
    intervalMs?: number
    verbose?: boolean
    onTransactionSubmitted?: (event: LadderTransactionSubmittedEvent) => void | Promise<void>
  }): Promise<LadderMonitorReport> {
    if (this.configs.length === 0) {
      throw new LadderConfigurationError(
        'ladder',
        'requires at least one configured market for monitoring'
      )
    }
    const runRemovedMarketCleanup = async () => this.make.cleanupRemovedMarkets?.()
    if (parameters.runOperation) await parameters.runOperation(runRemovedMarketCleanup)
    else await runRemovedMarketCleanup()

    const intervalMs = parameters.intervalMs ?? this.monitorIntervalMs()
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new LadderConfigurationError(
        'ladder monitor interval',
        'must be a positive safe integer'
      )
    }

    let cycles = 0
    let reason: LadderMonitorReport['reason'] = 'signal'
    let lastCycle: readonly LadderRunResult[] | undefined
    let cycleErrorName: string | undefined

    while (!parameters.signal.aborted) {
      try {
        const runCycle = async () => {
          if (parameters.signal.aborted) return undefined
          const results = await this.runOnce({
            verbose: parameters.verbose,
            onTransactionSubmitted: parameters.onTransactionSubmitted
          })
          await parameters.onCycle?.(results)
          return results
        }
        const results = parameters.runOperation
          ? await parameters.runOperation(runCycle)
          : await runCycle()
        if (results === undefined) break
        cycles += 1

        if (cycleHasFailure(results)) {
          reason = 'cycle-failed'
          lastCycle = results
          break
        }
      } catch (error) {
        reason = 'cycle-error'
        cycleErrorName = operatorErrorName(error)
        break
      }

      await waitForMonitorInterval(intervalMs, parameters.signal)
    }

    let cleanup: LadderMonitorReport['cleanup']
    try {
      const runCleanup = () =>
        this.cleanup({
          onTransactionSubmitted:
            parameters.verbose && parameters.onTransactionSubmitted
              ? transaction =>
                  parameters.onTransactionSubmitted?.({
                    event: 'ladder.transaction-submitted',
                    ...transaction
                  })
              : undefined
        })
      const result = parameters.runOperation
        ? await parameters.runOperation(runCleanup)
        : await runCleanup()
      cleanup = {
        status: result === 'logged' ? 'logged' : 'applied',
        ...(parameters.verbose && result !== undefined && result !== 'logged'
          ? { submittedTransactions: result.submittedTransactions }
          : {})
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
   * Invalidates every strategy-owned ladder group after monitoring stops.
   * @param parameters - Optional transaction-submission observer for verbose output.
   * @returns `logged` for read-only cleanup or confirmed hashes after live invalidations.
   * @throws When the make adapter cannot complete exhaustive strategy cleanup.
   * @remarks Cleanup is serialized behind any in-flight publication, replacement, or invalidation.
   */
  cleanup(
    parameters: {
      onTransactionSubmitted?: LadderTransactionSubmittedObserver
    } = {}
  ) {
    return this.make.cleanup(parameters)
  }

  /**
   * Preflights every config, then reconciles one fresh cycle for each configured market.
   * @param parameters - Optional verbose flag and immediate transaction-submission observer.
   * @returns Ordered outcomes; dry-run make requests are `logged`, never `applied`.
   * @throws `LadderConfigurationError` when no market is configured. Other handled config,
   * provider, decision, and invalidation failures are returned as sanitized outcomes.
   * @remarks Retains an active center inside the inclusive movement tolerance while still deriving
   * fresh sizes. Verbose mode adds a fresh post-check read without exposing signer or provider
   * details. All publication and invalidation side effects pass exclusively through `make`.
   */
  async runOnce(parameters: LadderRunParameters = {}) {
    if (this.configs.length === 0) {
      throw new LadderConfigurationError('ladder', 'requires at least one configured market')
    }
    await this.make.cleanupRemovedMarkets?.()
    for (const config of this.configs) {
      try {
        validateLadderConfig(config)
      } catch (error) {
        const result = await this.halt(
          config.marketId,
          'configuration',
          error,
          'ladder-configuration-failed',
          parameters
        )
        const submittedTransactions =
          result.makeResult !== undefined && result.makeResult !== 'logged'
            ? result.makeResult.submittedTransactions
            : []
        return [
          await this.completeResult(config, result.result, parameters, {
            config,
            currentState: { status: 'not-read', reason: 'configuration-invalid' },
            ...(submittedTransactions.length > 0 ? { submittedTransactions } : {})
          })
        ]
      }
    }

    const results: LadderRunResult[] = []
    for (const config of this.configs) {
      const startedAt = Date.now()
      let active: LadderQuoteSet | undefined
      // Sampled here rather than after reconciliation: replacing a quote forgets the old group from
      // durable ownership, so a fill on it would never be observed on the cycle that replaced it —
      // which is exactly the cycle a fill causes. Runs with the active read so both share one
      // deduplicated groups request.
      let groupConsumption: readonly LadderGroupConsumption[] | undefined
      try {
        const state = this.make.readActiveState
          ? await this.make.readActiveState(config.marketId)
          : { quote: await this.make.readActive(config.marketId), consumption: undefined }
        active = state.quote
        groupConsumption = state.consumption
      } catch (error) {
        const result = await this.halt(
          config.marketId,
          'decision',
          error,
          'ladder-decision-failed',
          parameters
        )
        const submittedTransactions =
          result.makeResult !== undefined && result.makeResult !== 'logged'
            ? result.makeResult.submittedTransactions
            : []
        results.push(
          await this.completeResult(
            config,
            result.result,
            parameters,
            {
              config,
              currentState: { status: 'failed', errorName: operatorErrorName(error) },
              ...(submittedTransactions.length > 0 ? { submittedTransactions } : {})
            },
            startedAt
          )
        )
        return results
      }

      let market: LadderMarketState
      try {
        market = await this.positions.readMarket(config.marketId)
      } catch (error) {
        const { result, invalidation } = await this.failedMarketRead(config, error, parameters)
        const submittedTransactions =
          invalidation === undefined ||
          invalidation === 'logged' ||
          invalidation.submittedTransactions.length === 0
            ? undefined
            : invalidation.submittedTransactions
        results.push(
          await this.completeResult(
            config,
            result,
            parameters,
            {
              config,
              currentState: { status: 'failed', errorName: operatorErrorName(error) },
              ...(submittedTransactions ? { submittedTransactions } : {})
            },
            startedAt
          )
        )
        if (result.status === 'halted') return results
        continue
      }

      const currentState: LadderVerboseState = {
        status: 'observed',
        market,
        ...(active ? { activeQuote: active } : {})
      }

      let referenceRateBps: bigint
      let referenceObservationId: string | undefined
      try {
        if (this.rates.readObservation) {
          const observation = await this.rates.readObservation(config.marketId)
          referenceRateBps = observation.rateBps
          referenceObservationId = observation.observationId
        } else {
          referenceRateBps = await this.rates.readRate(config.marketId)
        }
      } catch (error) {
        const result = await this.halt(
          config.marketId,
          'reference-read',
          error,
          'reference-read-failed',
          parameters
        )
        const submittedTransactions =
          result.makeResult !== undefined && result.makeResult !== 'logged'
            ? result.makeResult.submittedTransactions
            : []
        results.push(
          await this.completeResult(
            config,
            result.result,
            parameters,
            {
              config,
              currentState,
              ...(groupConsumption ? { groupConsumption } : {}),
              ...(submittedTransactions.length > 0 ? { submittedTransactions } : {})
            },
            startedAt
          )
        )
        return results
      }

      let desired: LadderQuoteSet
      let decision: 'publish' | 'recenter' | 'resize' | 'rest'
      let diagnostics: LadderDiagnostics | undefined
      try {
        const targetRateBps = referenceRateBps + config.quotePremiumBps
        const recenter = active
          ? shouldRecenter(active.centerRateBps, targetRateBps, config.movementToleranceBps)
          : true
        const generation =
          active && !recenter
            ? generateLadderWithDiagnostics({
                config,
                referenceRateBps,
                capacities: market,
                retainedCenterRateBps: active.centerRateBps
              })
            : generateLadderWithDiagnostics({ config, referenceRateBps, capacities: market })
        diagnostics = generation.diagnostics
        const generated = generation.quote
        desired = referenceObservationId ? { ...generated, referenceObservationId } : generated
        if (!active) decision = 'publish'
        else if (sameLadderQuoteSet(active, desired)) decision = 'rest'
        else decision = recenter ? 'recenter' : 'resize'
      } catch (error) {
        const result = await this.halt(
          config.marketId,
          'decision',
          error,
          'ladder-decision-failed',
          parameters
        )
        const submittedTransactions =
          result.makeResult !== undefined && result.makeResult !== 'logged'
            ? result.makeResult.submittedTransactions
            : []
        results.push(
          await this.completeResult(
            config,
            result.result,
            parameters,
            {
              config,
              currentState,
              referenceRateBps,
              targetRateBps: referenceRateBps + config.quotePremiumBps,
              ...(groupConsumption ? { groupConsumption } : {}),
              ...(submittedTransactions.length > 0 ? { submittedTransactions } : {})
            },
            startedAt
          )
        )
        return results
      }

      const desiredPublication =
        desired.lower.length === 0 && desired.higher.length === 0 ? undefined : desired
      if (!active && !desiredPublication) decision = 'rest'

      const verbosePlan: LadderVerbosePlan = {
        config,
        currentState,
        referenceRateBps,
        targetRateBps: referenceRateBps + config.quotePremiumBps,
        ladderOffer: desired,
        decision,
        ...(diagnostics ? { diagnostics } : {}),
        ...(groupConsumption ? { groupConsumption } : {})
      }

      let reconciliation: LadderMakeResult
      try {
        reconciliation = await this.make.reconcile({
          marketId: config.marketId,
          desired: desiredPublication,
          reason: decision,
          onTransactionSubmitted: this.marketObserver(config.marketId, parameters)
        })
      } catch (error) {
        const ownershipCleanup = error instanceof LadderOwnershipCleanupError ? error : undefined
        const confirmedTransactions =
          ownershipCleanup?.submittedTransactions ??
          (error instanceof LadderAdapterError ? error.confirmedTransactions : [])
        results.push(
          await this.completeResult(
            config,
            {
              marketId: config.marketId,
              status: 'failed',
              stage: 'reconcile',
              invalidated: ownershipCleanup !== undefined,
              errorName: operatorErrorName(error),
              ...(ownershipCleanup
                ? { ownershipCleanupErrorName: ownershipCleanup.cleanupErrorName }
                : {})
            },
            parameters,
            {
              ...verbosePlan,
              ...(confirmedTransactions.length > 0
                ? { submittedTransactions: confirmedTransactions }
                : {})
            },
            startedAt
          )
        )
        continue
      }

      const submittedTransactions =
        reconciliation === undefined || reconciliation === 'logged'
          ? undefined
          : reconciliation.submittedTransactions
      if (decision === 'rest') {
        results.push(
          await this.completeResult(
            config,
            { marketId: config.marketId, status: 'observed', action: 'rest' },
            parameters,
            { ...verbosePlan, ...(submittedTransactions ? { submittedTransactions } : {}) },
            startedAt
          )
        )
        continue
      }
      results.push(
        await this.completeResult(
          config,
          {
            marketId: config.marketId,
            status: reconciliation === 'logged' ? 'logged' : 'applied',
            action: decision === 'publish' ? 'publish' : 'replace',
            reason: decision
          },
          parameters,
          { ...verbosePlan, ...(submittedTransactions ? { submittedTransactions } : {}) },
          startedAt
        )
      )
    }
    return results
  }

  private monitorIntervalMs() {
    const seconds = Math.min(...this.configs.map(config => config.loopIntervalSeconds))
    return seconds * 1_000
  }

  private async failedMarketRead(
    config: LadderConfig,
    error: unknown,
    parameters: LadderRunParameters
  ): Promise<{ result: LadderRunOutcome; invalidation?: LadderMakeResult }> {
    try {
      const invalidation = await this.make.reconcile({
        marketId: config.marketId,
        desired: undefined,
        reason: 'market-read-failed',
        onTransactionSubmitted: this.marketObserver(config.marketId, parameters)
      })

      return {
        result: {
          marketId: config.marketId,
          status: 'failed',
          stage: 'market-read',
          invalidated: invalidation !== 'logged',
          ...(invalidation === 'logged' ? { invalidationLogged: true } : {}),
          errorName: operatorErrorName(error)
        },
        invalidation
      }
    } catch (invalidationError) {
      const halt = await this.halt(
        config.marketId,
        'market-invalidation',
        error,
        'market-invalidation-failed',
        parameters,
        invalidationError
      )
      return {
        result: halt.result,
        invalidation: halt.makeResult
      }
    }
  }

  private async completeResult(
    config: LadderConfig,
    result: LadderRunOutcome,
    parameters: LadderRunParameters,
    verbose: LadderVerbosePlan,
    startedAt?: number
  ): Promise<LadderRunResult> {
    if (parameters.verbose !== true) return result
    const stateAfterCheck =
      verbose.currentState.status === 'not-read'
        ? verbose.currentState
        : await this.readVerboseState(config.marketId)
    return {
      ...result,
      verbose: {
        ...verbose,
        stateAfterCheck,
        ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt })
      }
    }
  }

  private async readVerboseState(marketId: Hex): Promise<LadderVerboseState> {
    try {
      const [market, activeQuote] = await Promise.all([
        this.positions.readMarket(marketId),
        this.make.readActive(marketId)
      ])
      return {
        status: 'observed',
        market,
        ...(activeQuote ? { activeQuote } : {})
      }
    } catch (error) {
      return { status: 'failed', errorName: operatorErrorName(error) }
    }
  }

  private marketObserver(marketId: Hex, parameters: LadderRunParameters) {
    if (!parameters.onTransactionSubmitted) return undefined
    return (transaction: LadderSubmittedTransaction) =>
      parameters.onTransactionSubmitted?.({
        event: 'ladder.transaction-submitted',
        marketId,
        ...transaction
      })
  }

  private async halt(
    marketId: Hex,
    stage: Extract<LadderRunOutcome, { status: 'halted' }>['stage'],
    error: unknown,
    reason: Parameters<LadderMakeService['hardHalt']>[0]['reason'],
    parameters: LadderRunParameters,
    marketInvalidationError?: unknown
  ): Promise<{ result: LadderRunOutcome; makeResult?: LadderMakeResult }> {
    const marketInvalidationFailure =
      marketInvalidationError === undefined
        ? {}
        : { marketInvalidationErrorName: operatorErrorName(marketInvalidationError) }
    try {
      const invalidation = await this.make.hardHalt({
        reason,
        onTransactionSubmitted: parameters.onTransactionSubmitted
          ? transaction =>
              parameters.onTransactionSubmitted?.({
                event: 'ladder.transaction-submitted',
                ...transaction
              })
          : undefined
      })
      return {
        result: {
          marketId,
          status: 'halted',
          stage,
          strategyInvalidated: invalidation !== 'logged',
          ...(invalidation === 'logged' ? { strategyInvalidationLogged: true } : {}),
          errorName: operatorErrorName(error),
          ...marketInvalidationFailure
        },
        makeResult: invalidation
      }
    } catch (invalidationError) {
      return {
        result: {
          marketId,
          status: 'halted',
          stage,
          strategyInvalidated: false,
          errorName: operatorErrorName(error),
          ...marketInvalidationFailure,
          invalidationErrorName: operatorErrorName(invalidationError)
        }
      }
    }
  }
}
