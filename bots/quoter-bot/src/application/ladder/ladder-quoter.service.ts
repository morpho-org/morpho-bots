import type { MonitorOperationQueue } from '@repo/monitoring'
import type { Hex } from 'viem'

import { cycleHasFailure, cycleRequiresHalt, waitForMonitorInterval } from '@repo/monitoring'
import { withActiveSpan } from '@repo/telemetry'

import type {
  LadderDiagnostics,
  LadderMarketState,
  LadderQuoteSet,
  LadderWithdrawnSide,
  ValidLadderConfig
} from '../../domain/ladder'
import type { LendHalt, LossFactorObservation } from '../../domain/loss-factor'
import type { OperatorAdapterOperation } from '../monitoring/operator-error-name.utils'
import type {
  LadderBookReconciliation,
  LadderBookSideCrossingReport,
  LadderGroupConsumption,
  LadderMakeResult,
  LadderSubmittedTransaction,
  LadderTransactionSubmittedEvent,
  LadderTransactionSubmittedObserver,
  LadderVerboseDetails,
  LadderVerboseState
} from './ladder-verbose'

import {
  effectiveLadderPremiumBps,
  generateLadderWithDiagnostics,
  shouldRecenter
} from '../../domain/ladder'
import { LadderConfigurationError } from '../../domain/ladder-configuration.error'
import { lendHalt } from '../../domain/loss-factor'
import {
  MARKET_FAILURE_BUDGET_CYCLES,
  createMarketFailureBudget
} from '../../domain/market-failure-budget'
import { marketObservationMatured } from '../../domain/market-maturity'
import { snapshotErrorOperationField } from '../../infrastructure/exposure/exposure-admission.utils'
import { LadderAdapterError } from '../../infrastructure/ladder/ladder-adapter.error'
import { adapterOperationField, operatorErrorName } from '../monitoring/operator-error-name.utils'
import { LadderOwnershipCleanupError } from './ladder-ownership-cleanup.error'
import { sameLadderQuoteSet } from './ladder-quoter.utils'

const SIDES = ['lower', 'higher'] as const

const withdrawnSidesUnion = (
  snapshot: readonly LadderWithdrawnSide[],
  publication: readonly LadderWithdrawnSide[] = []
) => {
  const sides = SIDES.filter(side => snapshot.includes(side) || publication.includes(side))
  return sides.length === 0 ? undefined : sides
}

const withWithdrawnSides = <T extends LadderRunOutcome>(
  outcome: T,
  withdrawnSides: readonly LadderWithdrawnSide[] | undefined
): T => (withdrawnSides === undefined ? outcome : { ...outcome, withdrawnSides })

const loggedMakeResult = (result: LadderMakeResult) =>
  result === 'logged' || (result !== undefined && result.logged === true)

const confirmedCancellation = (transactions: readonly LadderSubmittedTransaction[]) =>
  transactions.some(transaction => transaction.operation === 'cancel')

const withheldAfterCancellation = (error: unknown) =>
  error instanceof LadderAdapterError &&
  error.operation === 'publication-reservation-cleanup' &&
  confirmedCancellation(error.confirmedTransactions)

/** Consumer-owned port for fresh position and capacity inputs for one ladder market. */
export interface LadderPositionService {
  /**
   * Reads only the market loss factor beside its accepted value, at one block.
   * @param marketId - Canonical market identifier to inspect.
   * @returns The observation that decides whether this market may lend.
   * @throws When the loss factor cannot be read or is not a uint128.
   * @remarks Kept apart from {@link LadderPositionService.readMarket} so no book, group, or
   * snapshot failure can stop a halted market's buys from being cancelled.
   */
  readLendGuard(marketId: Hex): Promise<LossFactorObservation>
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
   * @returns Current rate and stable freshness observation identity, extended with fresh seconds
   * to maturity when this market's maturity-premium configuration requires that observation.
   * @throws When the rate provider cannot return a fresh valid reference.
   * @remarks Read-only: implementations may reach providers over the network but must not
   * publish, replace, invalidate, or persist anything.
   */
  readObservation?(
    marketId: Hex
  ): Promise<{ rateBps: bigint; observationId: string; secondsToMaturity?: bigint }>
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
    reason:
      | 'publish'
      | 'recenter'
      | 'resize'
      | 'rest'
      | 'book-crossed'
      | 'market-matured'
      | 'market-read-failed'
    /** Sides whose cooldown admitted a `book-crossed` replacement; the recheck may mutate only for one of them. */
    bookCrossedSides?: readonly ('lower' | 'higher')[]
    onTransactionSubmitted?: LadderTransactionSubmittedObserver
  }): Promise<LadderMakeResult>
  /**
   * Cancels every durably owned buy group of one market and nothing else.
   * @param parameters - Market, stable reason, and optional transaction-submission observer.
   * @returns `logged` for a dry-run, otherwise the confirmed cancellation.
   * @throws When any unconsumed buy group cannot be cancelled with a confirmed receipt; ownership
   * is kept for every group whose cancellation is not confirmed.
   * @remarks Reads no book and prepares no replacement, so neither can stop the cancellation. Sell
   * groups are untouched.
   */
  cancelBuys(parameters: {
    marketId: Hex
    reason: 'loss-factor-mismatch' | 'guard-read-failed'
    onTransactionSubmitted?: LadderTransactionSubmittedObserver
  }): Promise<LadderMakeResult>
  /**
   * Invalidates all strategy-owned roots after an unsafe cycle-level failure.
   * @param parameters - Stable safety reason and optional transaction-submission observer.
   * @returns `logged` for a dry-run, otherwise confirmed cancellation hashes.
   * @throws When complete strategy-root invalidation cannot be confirmed.
   */
  hardHalt(parameters: {
    reason: 'reference-read-failed' | 'ladder-decision-failed' | 'market-invalidation-failed'
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
  | {
      marketId: Hex
      status: 'observed'
      action: 'rest'
      withdrawnSides?: readonly LadderWithdrawnSide[]
    }
  | ({
      marketId: Hex
      status: 'observed' | 'applied' | 'logged'
      action: 'lend-halted'
      reason: 'loss-factor-mismatch'
    } & LendHalt)
  | { marketId: Hex; status: 'observed' | 'applied' | 'logged'; action: 'matured' }
  | {
      marketId: Hex
      status: 'applied' | 'logged'
      action: 'publish' | 'replace'
      reason: 'publish' | 'recenter' | 'resize' | 'book-crossed'
      withdrawnSides?: readonly LadderWithdrawnSide[]
    }
  | {
      marketId: Hex
      /** `applied` only when replaced groups were cancelled; nothing is ever published. */
      status: 'observed' | 'applied' | 'logged'
      action: 'publication-withdrawn'
      reason: 'publish' | 'recenter' | 'resize' | 'book-crossed'
      withdrawnSides: readonly LadderWithdrawnSide[]
    }
  | {
      marketId: Hex
      status: 'applied'
      action: 'publication-withheld'
      reason: 'capacity-changed' | 'price-changed'
      withdrawnSides?: readonly LadderWithdrawnSide[]
    }
  | ({
      marketId: Hex
      status: 'applied'
      action: 'publication-withheld'
      reason: 'loss-factor-mismatch'
      withdrawnSides?: readonly LadderWithdrawnSide[]
    } & LendHalt)
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
      stage: 'guard-read'
      invalidated: boolean
      invalidationLogged?: boolean
      errorName: string
      adapterOperation?: OperatorAdapterOperation
    }
  | ({
      marketId: Hex
      status: 'failed'
      stage: 'reconcile'
      invalidated: boolean
      errorName: string
      adapterOperation?: OperatorAdapterOperation
      snapshotErrorOperation?: OperatorAdapterOperation
      ownershipCleanupErrorName?: string
      withdrawnSides?: readonly LadderWithdrawnSide[]
    } & Partial<LendHalt>)
  | ({
      marketId: Hex
      status: 'halted'
      stage: 'reference-read' | 'decision' | 'market-invalidation'
      /** Why the failed market invalidation was attempted, when it was a lend halt. */
      reason?: 'loss-factor-mismatch' | 'guard-read'
      strategyInvalidated: boolean
      strategyInvalidationLogged?: boolean
      errorName: string
      adapterOperation?: OperatorAdapterOperation
      marketInvalidationErrorName?: string
      invalidationErrorName?: string
    } & Partial<LendHalt>)

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
  /** Most recent cycle that contained a handled failure, cleared by any fully successful cycle. */
  lastCycle?: readonly LadderRunResult[]
  /** Sanitized unexpected cycle or output-writer error classification. */
  cycleErrorName?: string
}

/** Coordinates deterministic ladder decisions through fresh read and explicit make outcomes. */
export class LadderQuoterService {
  // Process memory by design: a restart forgets it and at worst replaces once early.
  private readonly bookCrossedReplacedAt = new Map<Hex, { lower?: bigint; higher?: bigint }>()

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
    private readonly configs: readonly ValidLadderConfig[]
  ) {}

  /**
   * Repeats complete ladder observations until shutdown, then invalidates owned ladder groups.
   * @param parameters - Shutdown signal, optional cycle writer, test interval, and verbose hooks.
   * @returns A terminal report after cleanup has been attempted.
   * @throws `LadderConfigurationError` before cleanup when no market or interval is usable.
   * @remarks Configured markets that have reached maturity are rested rather than quoted, which is
   * not a cycle failure, so monitoring survives a normal market lifecycle end.
   * Cycles never overlap. Production cadence uses the shortest configured market interval;
   * a test-only `intervalMs` override applies to the complete configured set. Cleanup is serialized
   * through the make port after the final in-flight cycle. Verbose cycles perform a fresh
   * market/active-quote read after every check and emit submitted transaction hashes immediately.
   */
  // oxlint-disable-next-line complexity
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
    const intervalMs = parameters.intervalMs ?? this.monitorIntervalMs()
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new LadderConfigurationError(
        'ladder monitor interval',
        'must be a positive safe integer'
      )
    }

    const failureBudget = createMarketFailureBudget(MARKET_FAILURE_BUDGET_CYCLES)
    const unresolvedPublicationMarkets = new Set<Hex>()
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
        // The span wraps the enqueue, so wait behind the shared mutation queue is traced.
        const results = await withActiveSpan(
          {
            name: 'quoter-bot.cycle',
            attributes: { workflow: 'ladder' },
            errorName: operatorErrorName,
            failed: cycle => cycle !== undefined && cycleHasFailure(cycle)
          },
          () => (parameters.runOperation ? parameters.runOperation(runCycle) : runCycle())
        )
        if (results === undefined) break
        cycles += 1

        for (const result of results) {
          // oxlint-disable-next-line max-depth
          if (result.status === 'failed' && result.stage === 'reconcile') {
            unresolvedPublicationMarkets.add(result.marketId)
          } else if (
            result.status === 'applied' ||
            result.status === 'logged' ||
            ('action' in result &&
              (result.action === 'lend-halted' || result.action === 'publication-withdrawn'))
          ) {
            unresolvedPublicationMarkets.delete(result.marketId)
          }
        }
        const budgetExhausted = failureBudget(results, unresolvedPublicationMarkets)
        lastCycle = cycleHasFailure(results) ? results : undefined
        if (cycleRequiresHalt(results) || budgetExhausted) {
          reason = 'cycle-failed'
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
   * Reconciles one fresh cycle for each configured market.
   * @param parameters - Optional verbose flag and immediate transaction-submission observer.
   * @returns Ordered outcomes; dry-run make requests are `logged`, never `applied`.
   * @throws `LadderConfigurationError` when no market is configured. Other handled provider,
   * decision, and invalidation failures are returned as sanitized outcomes.
   * @remarks Retains an active center inside the inclusive movement tolerance while still deriving
   * fresh sizes. Verbose mode adds a fresh post-check read without exposing signer or provider
   * details. All publication and invalidation side effects pass exclusively through `make`. A market
   * whose fresh read shows maturity already reached is not quoted: its owned groups are invalidated
   * and it reports the non-failing `matured` action, so the remaining configured markets keep
   * quoting and monitoring continues into later cycles. A resting ladder a third party has
   * crossed on a clearable side is replaced with reason `book-crossed` once that side's cooldown
   * has elapsed; `make` rechecks the crossing under its own lock, so one that cleared in between
   * mutates nothing and the cycle reports `rest`. Every market's loss-factor guard, and the buy
   * cancellation it requires, runs before removed-market cleanup or any other read or mutation, so
   * no failure there can leave a mismatched buy live.
   */
  // oxlint-disable-next-line complexity
  async runOnce(parameters: LadderRunParameters = {}) {
    if (this.configs.length === 0) {
      throw new LadderConfigurationError('ladder', 'requires at least one configured market')
    }
    const guarded = new Map<Hex, LadderRunResult>()
    for (const config of this.configs) {
      const result = await this.guardLending(config, parameters, Date.now())
      if (!result) continue
      if (result.status === 'halted') return [...guarded.values(), result]
      guarded.set(config.marketId, result)
    }
    await this.make.cleanupRemovedMarkets?.()
    const results: LadderRunResult[] = []
    for (const config of this.configs) {
      const startedAt = Date.now()
      const lendHalted = guarded.get(config.marketId)
      if (lendHalted) {
        results.push(lendHalted)
        continue
      }
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

      if (marketObservationMatured(market)) {
        results.push(await this.settleMaturedMarket(config, currentState, parameters, startedAt))
        continue
      }

      let referenceRateBps: bigint
      let referenceObservationId: string | undefined
      let secondsToMaturity: bigint | undefined
      try {
        if (this.rates.readObservation) {
          const observation = await this.rates.readObservation(config.marketId)
          referenceRateBps = observation.rateBps
          referenceObservationId = observation.observationId
          secondsToMaturity = observation.secondsToMaturity
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
      let decision: 'publish' | 'recenter' | 'resize' | 'rest' | 'book-crossed'
      let diagnostics: LadderDiagnostics | undefined
      let snapshotWithdrawnSides: LadderWithdrawnSide[] = []
      try {
        const targetRateBps =
          referenceRateBps + effectiveLadderPremiumBps(config, secondsToMaturity)
        const recenter = active
          ? shouldRecenter(active.centerRateBps, targetRateBps, config.movementToleranceBps)
          : true
        const maturity = secondsToMaturity === undefined ? {} : { secondsToMaturity }
        const generation =
          active && !recenter
            ? generateLadderWithDiagnostics({
                config,
                referenceRateBps,
                capacities: market,
                retainedCenterRateBps: active.centerRateBps,
                ...maturity
              })
            : generateLadderWithDiagnostics({
                config,
                referenceRateBps,
                capacities: market,
                ...maturity
              })
        diagnostics = generation.diagnostics
        const generated = generation.quote
        snapshotWithdrawnSides = SIDES.filter(
          side => market.withdrawnSides?.includes(side) && generated[side].length > 0
        )
        desired = {
          ...generated,
          ...(snapshotWithdrawnSides.includes('lower') ? { lower: [] } : {}),
          ...(snapshotWithdrawnSides.includes('higher') ? { higher: [] } : {}),
          ...(referenceObservationId === undefined ? {} : { referenceObservationId })
        }
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
              ...(secondsToMaturity === undefined ? {} : { secondsToMaturity }),
              ...this.premiumDiagnostics(config, referenceRateBps, secondsToMaturity),
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
      if (!active && !desiredPublication && snapshotWithdrawnSides.length === 0) decision = 'rest'

      const bookCrossing = this.bookCrossingReport(config, market)
      const bookCrossedSides =
        bookCrossing === undefined
          ? []
          : SIDES.filter(
              side =>
                bookCrossing[side].crossed &&
                bookCrossing[side].clearable &&
                !bookCrossing[side].suppressed
            )
      if (
        decision === 'rest' &&
        active !== undefined &&
        desiredPublication !== undefined &&
        bookCrossedSides.length > 0
      ) {
        decision = 'book-crossed'
      }

      const verbosePlan: LadderVerbosePlan = {
        config,
        currentState,
        referenceRateBps,
        ...(secondsToMaturity === undefined ? {} : { secondsToMaturity }),
        ...this.premiumDiagnostics(config, referenceRateBps, secondsToMaturity),
        ladderOffer: desired,
        decision,
        ...(bookCrossing ? { bookCrossing } : {}),
        ...(diagnostics ? { diagnostics } : {}),
        ...(groupConsumption ? { groupConsumption } : {})
      }

      let reconciliation: LadderMakeResult
      try {
        reconciliation = await this.make.reconcile({
          marketId: config.marketId,
          desired: desiredPublication,
          reason: decision,
          ...(decision === 'book-crossed' ? { bookCrossedSides } : {}),
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
            withWithdrawnSides(
              {
                marketId: config.marketId,
                status: 'failed',
                stage: 'reconcile',
                invalidated: ownershipCleanup !== undefined || withheldAfterCancellation(error),
                errorName: operatorErrorName(error),
                ...adapterOperationField(error),
                ...(ownershipCleanup
                  ? { ownershipCleanupErrorName: ownershipCleanup.cleanupErrorName }
                  : {})
              },
              withdrawnSidesUnion(snapshotWithdrawnSides)
            ),
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

      const settled =
        reconciliation === undefined || reconciliation === 'logged' ? undefined : reconciliation
      const bookReconciliation = settled?.reconciliation
      if (bookReconciliation?.applied === true && !settled?.publicationWithheld) {
        this.advanceBookCrossedCooldown(config.marketId, bookReconciliation)
      }
      const submittedTransactions = settled?.submittedTransactions
      const withdrawnSides = withdrawnSidesUnion(snapshotWithdrawnSides, settled?.withdrawnSides)
      const reconciled = {
        ...verbosePlan,
        ...(submittedTransactions ? { submittedTransactions } : {}),
        ...(settled?.bookClearedRungs ? { bookClearedRungs: settled.bookClearedRungs } : {}),
        ...(withdrawnSides ? { withdrawnSides } : {}),
        ...(bookReconciliation ? { bookReconciliation } : {})
      }
      const withheld = settled?.publicationWithheld
      if (withheld) {
        results.push(
          await this.completeResult(
            config,
            withWithdrawnSides<LadderRunOutcome>(
              withheld.reason !== 'snapshot-unavailable'
                ? {
                    marketId: config.marketId,
                    status: 'applied',
                    action: 'publication-withheld',
                    ...withheld
                  }
                : {
                    marketId: config.marketId,
                    status: 'failed',
                    stage: 'reconcile',
                    invalidated: confirmedCancellation(submittedTransactions ?? []),
                    errorName: withheld.errorName,
                    adapterOperation: withheld.reason,
                    ...snapshotErrorOperationField(withheld)
                  },
              withdrawnSides
            ),
            parameters,
            reconciled,
            startedAt
          )
        )
        continue
      }
      const nothingLeftToClear =
        decision === 'book-crossed' && bookReconciliation?.applied === false
      if (decision === 'rest' || nothingLeftToClear) {
        results.push(
          await this.completeResult(
            config,
            withWithdrawnSides(
              { marketId: config.marketId, status: 'observed', action: 'rest' },
              withdrawnSides
            ),
            parameters,
            reconciled,
            startedAt
          )
        )
        continue
      }
      const publishedSides = SIDES.filter(
        side => (desiredPublication?.[side].length ?? 0) > 0 && !withdrawnSides?.includes(side)
      )
      results.push(
        await this.completeResult(
          config,
          withdrawnSides && publishedSides.length === 0
            ? {
                marketId: config.marketId,
                status: loggedMakeResult(reconciliation)
                  ? 'logged'
                  : confirmedCancellation(submittedTransactions ?? [])
                    ? 'applied'
                    : 'observed',
                action: 'publication-withdrawn',
                reason: decision,
                withdrawnSides
              }
            : withWithdrawnSides(
                {
                  marketId: config.marketId,
                  status: loggedMakeResult(reconciliation) ? 'logged' : 'applied',
                  action: decision === 'publish' ? 'publish' : 'replace',
                  reason: decision
                },
                withdrawnSides
              ),
          parameters,
          reconciled,
          startedAt
        )
      )
    }
    return results
  }

  /**
   * Projects the pre-decision per-side crossing, marking a side its cooldown still throttles.
   * @param config - Market configuration whose `bookCrossedCooldownSeconds` gates each side.
   * @param market - Fresh market observation carrying the crossing and its block timestamp.
   * @returns One report per side, or `undefined` when the adapter reported no crossing at all.
   * @remarks A side with no recorded replacement, or an observation without a block timestamp, has
   * elapsed: the throttle may only ever suppress on positive evidence that it is too soon.
   */
  private bookCrossingReport(
    config: ValidLadderConfig,
    market: LadderMarketState
  ): { lower: LadderBookSideCrossingReport; higher: LadderBookSideCrossingReport } | undefined {
    const crossing = market.bookCrossing
    if (!crossing) return undefined
    const replacedAt = this.bookCrossedReplacedAt.get(config.marketId)
    const report = (side: (typeof SIDES)[number]): LadderBookSideCrossingReport => {
      const previous = replacedAt?.[side]
      const elapsed =
        previous === undefined ||
        market.observedTimestamp === undefined ||
        market.observedTimestamp - previous >= BigInt(config.bookCrossedCooldownSeconds)
      return {
        ...crossing[side],
        suppressed: crossing[side].crossed && crossing[side].clearable && !elapsed
      }
    }
    return { lower: report('lower'), higher: report('higher') }
  }

  private advanceBookCrossedCooldown(marketId: Hex, reconciliation: LadderBookReconciliation) {
    const replacedAt = this.bookCrossedReplacedAt.get(marketId) ?? {}
    for (const side of SIDES) {
      const crossing = reconciliation.bookCrossing[side]
      if (crossing.crossed && crossing.clearable) {
        replacedAt[side] = reconciliation.preparedAtTimestamp
      }
    }
    this.bookCrossedReplacedAt.set(marketId, replacedAt)
  }

  private monitorIntervalMs() {
    const seconds = Math.min(...this.configs.map(config => config.loopIntervalSeconds))
    return seconds * 1_000
  }

  private async settleMaturedMarket(
    config: ValidLadderConfig,
    currentState: LadderVerboseState,
    parameters: LadderRunParameters,
    startedAt: number
  ): Promise<LadderRunResult> {
    const verbosePlan: LadderVerbosePlan = { config, currentState, decision: 'matured' }
    let invalidation: LadderMakeResult
    try {
      invalidation = await this.make.reconcile({
        marketId: config.marketId,
        desired: undefined,
        reason: 'market-matured',
        onTransactionSubmitted: this.marketObserver(config.marketId, parameters)
      })
    } catch (error) {
      const ownershipCleanup = error instanceof LadderOwnershipCleanupError ? error : undefined
      const confirmedTransactions =
        ownershipCleanup?.submittedTransactions ??
        (error instanceof LadderAdapterError ? error.confirmedTransactions : [])
      return this.completeResult(
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
    }
    const submittedTransactions =
      invalidation === undefined || invalidation === 'logged'
        ? undefined
        : invalidation.submittedTransactions
    return this.completeResult(
      config,
      {
        marketId: config.marketId,
        status: loggedMakeResult(invalidation)
          ? 'logged'
          : submittedTransactions && submittedTransactions.length > 0
            ? 'applied'
            : 'observed',
        action: 'matured'
      },
      parameters,
      { ...verbosePlan, ...(submittedTransactions ? { submittedTransactions } : {}) },
      startedAt
    )
  }

  /**
   * Cancels a market's buys when its loss factor differs from the accepted value or cannot be read.
   * @returns The market's outcome for this cycle, or `undefined` when the market may lend.
   */
  private async guardLending(
    config: ValidLadderConfig,
    parameters: LadderRunParameters,
    startedAt: number
  ): Promise<LadderRunResult | undefined> {
    let halt: LendHalt | undefined
    let guardError: unknown
    try {
      halt = lendHalt(await this.positions.readLendGuard(config.marketId))
      if (!halt) return undefined
    } catch (error) {
      guardError = error
    }
    const verbosePlan: LadderVerbosePlan = {
      config,
      currentState: halt
        ? { status: 'lend-halted', lossFactor: halt }
        : { status: 'failed', errorName: operatorErrorName(guardError) },
      decision: 'lend-halted'
    }
    let cancellation: LadderMakeResult
    try {
      cancellation = await this.make.cancelBuys({
        marketId: config.marketId,
        reason: halt ? 'loss-factor-mismatch' : 'guard-read-failed',
        onTransactionSubmitted: this.marketObserver(config.marketId, parameters)
      })
    } catch (error) {
      if (error instanceof LadderOwnershipCleanupError) {
        return this.completeResult(
          config,
          {
            marketId: config.marketId,
            status: 'failed',
            stage: 'reconcile',
            invalidated: true,
            errorName: operatorErrorName(error),
            ownershipCleanupErrorName: error.cleanupErrorName,
            ...halt
          },
          parameters,
          { ...verbosePlan, submittedTransactions: error.submittedTransactions },
          startedAt
        )
      }
      const stopped = await this.halt(
        config.marketId,
        'market-invalidation',
        guardError ?? error,
        'market-invalidation-failed',
        parameters,
        error
      )
      return this.completeResult(
        config,
        stopped.result.status === 'halted'
          ? { ...stopped.result, reason: halt ? 'loss-factor-mismatch' : 'guard-read', ...halt }
          : stopped.result,
        parameters,
        verbosePlan,
        startedAt
      )
    }
    const logged = loggedMakeResult(cancellation)
    const submittedTransactions =
      cancellation === undefined || cancellation === 'logged'
        ? []
        : cancellation.submittedTransactions
    const verbose = {
      ...verbosePlan,
      ...(submittedTransactions.length > 0 ? { submittedTransactions } : {})
    }
    if (!halt) {
      return this.completeResult(
        config,
        {
          marketId: config.marketId,
          status: 'failed',
          stage: 'guard-read',
          invalidated: !logged,
          ...(logged ? { invalidationLogged: true } : {}),
          errorName: operatorErrorName(guardError),
          ...adapterOperationField(guardError)
        },
        parameters,
        verbose,
        startedAt
      )
    }
    return this.completeResult(
      config,
      {
        marketId: config.marketId,
        status: logged ? 'logged' : submittedTransactions.length > 0 ? 'applied' : 'observed',
        action: 'lend-halted',
        reason: 'loss-factor-mismatch',
        ...halt
      },
      parameters,
      verbose,
      startedAt
    )
  }

  private async failedMarketRead(
    config: ValidLadderConfig,
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
          invalidated: !loggedMakeResult(invalidation),
          ...(loggedMakeResult(invalidation) ? { invalidationLogged: true } : {}),
          errorName: operatorErrorName(error),
          ...adapterOperationField(error)
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
    config: ValidLadderConfig,
    result: LadderRunOutcome,
    parameters: LadderRunParameters,
    verbose: LadderVerbosePlan,
    startedAt?: number
  ): Promise<LadderRunResult> {
    if (parameters.verbose !== true) return result
    const stateAfterCheck = await this.readVerboseState(config.marketId)
    return {
      ...result,
      verbose: {
        ...verbose,
        stateAfterCheck,
        ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt })
      }
    }
  }

  /**
   * Derives the safe premium and target-rate diagnostics for one verbose market result.
   * @param config - Market configuration whose static and optional maturity premiums apply.
   * @param referenceRateBps - Reference observation used by the decision for this market check.
   * @param secondsToMaturity - Fresh maturity observation read beside the reference, when wired.
   * @returns Resolved premium fields, or an empty object when the premium cannot be resolved
   * because the required maturity observation is missing; that configuration failure is already
   * reported by the decision itself, so diagnostics must not throw again inside result assembly.
   * @throws Rethrows any non-configuration failure instead of silently dropping diagnostics.
   */
  private premiumDiagnostics(
    config: ValidLadderConfig,
    referenceRateBps: bigint,
    secondsToMaturity: bigint | undefined
  ): Pick<LadderVerboseDetails, 'maturityPremiumBps' | 'targetRateBps'> {
    try {
      const premiumBps = effectiveLadderPremiumBps(config, secondsToMaturity)
      return {
        ...(config.maturityPremium
          ? { maturityPremiumBps: premiumBps - config.quotePremiumBps }
          : {}),
        targetRateBps: referenceRateBps + premiumBps
      }
    } catch (error) {
      if (error instanceof LadderConfigurationError) return {}
      throw error
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
          ...adapterOperationField(error),
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
          ...adapterOperationField(error),
          ...marketInvalidationFailure,
          invalidationErrorName: operatorErrorName(invalidationError)
        }
      }
    }
  }
}
