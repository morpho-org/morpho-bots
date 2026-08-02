import type { Hex } from 'viem'

import type { LadderConfig, LadderMarketState, LadderQuoteSet } from '../../domain/ladder/ladder'
import type {
  LadderMakeResult,
  LadderSubmittedTransaction,
  LadderTransactionSubmittedEvent,
  LadderTransactionSubmittedObserver,
  LadderVerboseDetails,
  LadderVerboseState
} from './ladder-verbose'

import { generateLadder, shouldRecenter, validateLadderConfig } from '../../domain/ladder/ladder'
import { LadderConfigurationError } from '../../domain/ladder/ladder-configuration.error'
import { waitForMonitorInterval } from '../monitor.utils'
import { operatorErrorName } from '../operator-error-name.utils'
import { sameLadderQuoteSet } from './ladder-market-maker.utils'
import { ladderCycleHasFailure } from './ladder-monitor.utils'
import { LadderOwnershipCleanupError } from './ladder-ownership-cleanup.error'

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
}

/** Consumer-owned blocking make boundary for ladder reconciliation and safety invalidation. */
export interface LadderMakeService {
  /**
   * Reads the currently active strategy-owned quote set from live book truth.
   * @param marketId - Canonical market identifier whose active roots must be reconstructed.
   * @returns Exact active quote set, or `undefined` when no strategy roots remain live.
   * @throws When active roots cannot be loaded or decoded safely.
   */
  readActive(marketId: Hex): Promise<LadderQuoteSet | undefined>
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
export class LadderMarketMakerService {
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
      let results: readonly LadderRunResult[]
      try {
        results = await this.runOnce({
          verbose: parameters.verbose,
          onTransactionSubmitted: parameters.onTransactionSubmitted
        })
        await parameters.onCycle?.(results)
        cycles += 1
      } catch (error) {
        reason = 'cycle-error'
        cycleErrorName = operatorErrorName(error)
        break
      }

      if (ladderCycleHasFailure(results)) {
        reason = 'cycle-failed'
        lastCycle = results
        break
      }

      await waitForMonitorInterval(intervalMs, parameters.signal)
    }

    let cleanup: LadderMonitorReport['cleanup']
    try {
      const result = await this.cleanup({
        onTransactionSubmitted:
          parameters.verbose && parameters.onTransactionSubmitted
            ? transaction =>
                parameters.onTransactionSubmitted?.({
                  event: 'ladder.transaction-submitted',
                  ...transaction
                })
            : undefined
      })
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
        return [
          await this.completeResult(config, result, parameters, {
            config,
            currentState: { status: 'not-read', reason: 'configuration-invalid' }
          })
        ]
      }
    }

    const results: LadderRunResult[] = []
    for (const config of this.configs) {
      let market: LadderMarketState
      try {
        market = await this.positions.readMarket(config.marketId)
      } catch (error) {
        const { result, invalidation } = await this.failedMarketRead(config, error, parameters)
        const submittedTransactions =
          invalidation === undefined || invalidation === 'logged'
            ? undefined
            : invalidation.submittedTransactions
        results.push(
          await this.completeResult(config, result, parameters, {
            config,
            currentState: { status: 'failed', errorName: operatorErrorName(error) },
            ...(submittedTransactions ? { submittedTransactions } : {})
          })
        )
        if (result.status === 'halted') return results
        continue
      }

      let active: LadderQuoteSet | undefined
      try {
        active = await this.make.readActive(config.marketId)
      } catch (error) {
        const result = await this.halt(
          config.marketId,
          'decision',
          error,
          'ladder-decision-failed',
          parameters
        )
        results.push(
          await this.completeResult(config, result, parameters, {
            config,
            currentState: { status: 'failed', errorName: operatorErrorName(error) }
          })
        )
        return results
      }

      const currentState: LadderVerboseState = {
        status: 'observed',
        market,
        ...(active ? { activeQuote: active } : {})
      }

      let referenceRateBps: bigint
      try {
        referenceRateBps = await this.rates.readRate(config.marketId)
      } catch (error) {
        const result = await this.halt(
          config.marketId,
          'reference-read',
          error,
          'reference-read-failed',
          parameters
        )
        results.push(
          await this.completeResult(config, result, parameters, { config, currentState })
        )
        return results
      }

      let desired: LadderQuoteSet
      let decision: 'publish' | 'recenter' | 'resize' | 'rest'
      try {
        const targetRateBps = referenceRateBps + config.quotePremiumBps
        const recenter = active
          ? shouldRecenter(active.centerRateBps, targetRateBps, config.movementToleranceBps)
          : true
        desired =
          active && !recenter
            ? generateLadder({
                config,
                referenceRateBps,
                capacities: market,
                retainedCenterRateBps: active.centerRateBps
              })
            : generateLadder({ config, referenceRateBps, capacities: market })
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
        results.push(
          await this.completeResult(config, result, parameters, {
            config,
            currentState,
            referenceRateBps,
            targetRateBps: referenceRateBps + config.quotePremiumBps
          })
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
        decision
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
              ...(ownershipCleanup
                ? { submittedTransactions: ownershipCleanup.submittedTransactions }
                : {})
            }
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
            { ...verbosePlan, ...(submittedTransactions ? { submittedTransactions } : {}) }
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
          { ...verbosePlan, ...(submittedTransactions ? { submittedTransactions } : {}) }
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
      return {
        result: await this.halt(
          config.marketId,
          'market-invalidation',
          error,
          'market-invalidation-failed',
          parameters,
          invalidationError
        )
      }
    }
  }

  private async completeResult(
    config: LadderConfig,
    result: LadderRunOutcome,
    parameters: LadderRunParameters,
    verbose: LadderVerbosePlan
  ): Promise<LadderRunResult> {
    if (parameters.verbose !== true) return result
    const stateAfterCheck =
      verbose.currentState.status === 'not-read'
        ? verbose.currentState
        : await this.readVerboseState(config.marketId)
    return { ...result, verbose: { ...verbose, stateAfterCheck } }
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
  ): Promise<LadderRunOutcome> {
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
        marketId,
        status: 'halted',
        stage,
        strategyInvalidated: invalidation !== 'logged',
        ...(invalidation === 'logged' ? { strategyInvalidationLogged: true } : {}),
        errorName: operatorErrorName(error),
        ...marketInvalidationFailure
      }
    } catch (invalidationError) {
      return {
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
