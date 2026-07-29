import type { Hex } from 'viem'

import type {
  BootstrapConfig,
  BootstrapOffer,
  BootstrapPosition,
  BootstrapRate,
  PositionBootstrapDecision
} from '../domain/position-bootstrap'

import {
  decidePositionBootstrap,
  decidePositionBootstrapTransition,
  validateBootstrapConfig
} from '../domain/position-bootstrap'
import { operatorErrorName } from './operator-error-name.utils'

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
   * @returns Completion after the requested publication or invalidation is confirmed.
   * @throws Error when simulation, publication, replacement, or invalidation fails.
   * @remarks This mutating port may change only the requested strategy-owned market group.
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
  }): Promise<void>
  /**
   * Invalidates all strategy-owned bootstrap groups after a cycle-level safety failure.
   * @param parameters - Fixed safety reason that triggered strategy-wide invalidation.
   * @returns Completion after every strategy-owned group is invalidated.
   * @throws Error when one or more strategy-owned groups cannot be invalidated.
   * @remarks This mutating port performs strategy-wide cleanup and must not publish offers.
   */
  hardHalt(parameters: {
    reason:
      | 'reference-read-failed'
      | 'bootstrap-decision-failed'
      | 'bootstrap-configuration-failed'
      | 'market-invalidation-failed'
  }): Promise<void>
}

type BootstrapRunResult =
  | {
      marketId: Hex
      status: 'observed'
      action: 'target-reached' | 'auto-refill-disabled' | 'no-capacity' | 'rest'
    }
  | { marketId: Hex; status: 'applied'; action: 'invalidate' | 'publish' | 'replace' }
  | {
      marketId: Hex
      status: 'failed'
      stage: 'position-read' | 'make'
      invalidated: boolean
      errorName: string
      invalidationErrorName?: string
    }
  | {
      marketId: Hex
      status: 'halted'
      stage: 'configuration' | 'reference-read' | 'decision'
      strategyInvalidated: boolean
      errorName: string
      invalidationErrorName?: string
    }
  | {
      marketId: Hex
      status: 'halted'
      stage: 'position-read'
      strategyInvalidated: boolean
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
      invalidationErrorName: string
      hardHaltErrorName?: string
    }

type BootstrapRunPlan =
  | { config: BootstrapConfig; decision: PositionBootstrapDecision }
  | { result: BootstrapRunResult }

/** Applies position-bootstrap cycles. Its in-memory one-shot gate resets on service recreation. */
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
   * Validates all configured markets, then applies one fresh bootstrap cycle per market.
   * @returns Ordered market outcomes, stopping after any strategy-wide safety halt.
   * @throws Never for handled provider, configuration, or make failures; their classifications and
   *   cleanup evidence are returned in the structured result.
   * @remarks Invalid configuration hard-halts before any position/reference read or publication.
   */
  async runOnce() {
    const results: BootstrapRunResult[] = []
    for (const config of this.configs) {
      try {
        validateBootstrapConfig(config)
      } catch (error) {
        results.push(
          await this.haltStrategy(
            config.marketId,
            'configuration',
            error,
            'bootstrap-configuration-failed'
          )
        )
        return results
      }
    }

    const plans: BootstrapRunPlan[] = []
    const preflightResults = () => plans.flatMap(plan => ('result' in plan ? [plan.result] : []))
    let reservedAssetsDelta = 0n
    const reservedAssetsDeltaByMarket = new Map<Hex, bigint>()

    for (const config of this.configs) {
      let position: Awaited<ReturnType<BootstrapPositionService['readPosition']>>
      try {
        position = await this.positions.readPosition(config.marketId)
      } catch (error) {
        const result = await this.failedMarketRead(
          config.marketId,
          'position-read',
          error,
          'market-read-failed'
        )
        if (result.status === 'halted') return [...preflightResults(), result]
        plans.push({ result })
        continue
      }
      const marketReservationDelta = reservedAssetsDeltaByMarket.get(config.marketId) ?? 0n
      position = {
        ...position,
        cashBalance:
          reservedAssetsDelta >= 0n
            ? position.cashBalance > reservedAssetsDelta
              ? position.cashBalance - reservedAssetsDelta
              : 0n
            : position.cashBalance - reservedAssetsDelta,
        marketExposure:
          marketReservationDelta >= 0n
            ? position.marketExposure + marketReservationDelta
            : position.marketExposure > -marketReservationDelta
              ? position.marketExposure + marketReservationDelta
              : 0n,
        totalExposure:
          reservedAssetsDelta >= 0n
            ? position.totalExposure + reservedAssetsDelta
            : position.totalExposure > -reservedAssetsDelta
              ? position.totalExposure + reservedAssetsDelta
              : 0n
      }

      let transition: ReturnType<typeof decidePositionBootstrapTransition>
      try {
        transition = decidePositionBootstrapTransition({
          config,
          position,
          activeOffer: position.activeOffer,
          initialTargetCompleted: this.completedMarkets.has(config.marketId)
        })
      } catch (error) {
        const result = await this.haltStrategy(
          config.marketId,
          'decision',
          error,
          'bootstrap-decision-failed'
        )
        return [...preflightResults(), result]
      }
      let decision: PositionBootstrapDecision

      if (transition) {
        decision = transition
      } else {
        let rate: BootstrapRate
        try {
          rate = await this.rates.readRate(config.marketId)
        } catch (error) {
          const result = await this.haltStrategy(
            config.marketId,
            'reference-read',
            error,
            'reference-read-failed'
          )
          return [...preflightResults(), result]
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
          const result = await this.haltStrategy(
            config.marketId,
            'decision',
            error,
            'bootstrap-decision-failed'
          )
          return [...preflightResults(), result]
        }
      }

      plans.push({ config, decision })
      if (decision.kind === 'publish' || decision.kind === 'replace') {
        const replacedAssets =
          decision.kind === 'replace' ? (position.activeOffer?.assets ?? 0n) : 0n
        const exposureDelta = decision.offer.assets - replacedAssets
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
        results.push({
          marketId: config.marketId,
          status: 'observed' as const,
          action: 'target-reached' as const
        })
        continue
      }
      if (decision.kind === 'observe') {
        results.push({
          marketId: config.marketId,
          status: 'observed' as const,
          action: decision.reason
        })
        continue
      }
      if (decision.kind === 'rest') {
        results.push({
          marketId: config.marketId,
          status: 'observed' as const,
          action: 'rest' as const
        })
        continue
      }
      if (decision.kind === 'invalidate') {
        try {
          await this.make.reconcile({
            marketId: config.marketId,
            desiredOffer: undefined,
            reason: decision.reason
          })
        } catch (error) {
          results.push(
            await this.haltAfterInvalidationFailure(
              config.marketId,
              { stage: 'make', reason: decision.reason },
              error
            )
          )
          return results
        }
        results.push({
          marketId: config.marketId,
          status: 'applied' as const,
          action: 'invalidate' as const
        })
        continue
      }

      try {
        await this.make.reconcile({
          marketId: config.marketId,
          desiredOffer: decision.offer,
          reason: decision.kind
        })
      } catch (error) {
        results.push({
          marketId: config.marketId,
          status: 'failed' as const,
          stage: 'make' as const,
          invalidated: false,
          errorName: operatorErrorName(error)
        })
        continue
      }
      results.push({ marketId: config.marketId, status: 'applied' as const, action: decision.kind })
    }
    return results
  }

  private async failedMarketRead(
    marketId: Hex,
    stage: 'position-read',
    readError: unknown,
    reason: 'market-read-failed'
  ): Promise<BootstrapRunResult> {
    try {
      await this.make.reconcile({ marketId, desiredOffer: undefined, reason })
      return {
        marketId,
        status: 'failed' as const,
        stage,
        invalidated: true,
        errorName: operatorErrorName(readError)
      }
    } catch (invalidationError) {
      return this.haltAfterInvalidationFailure(
        marketId,
        { stage, error: readError },
        invalidationError
      )
    }
  }

  private async haltAfterInvalidationFailure(
    marketId: Hex,
    context: FailedInvalidationContext,
    invalidationError: unknown
  ): Promise<BootstrapRunResult> {
    let hardHaltError: unknown
    try {
      await this.make.hardHalt({ reason: 'market-invalidation-failed' })
    } catch (error) {
      hardHaltError = error
    }
    const strategyInvalidated = hardHaltError === undefined
    const cleanupFailure = strategyInvalidated
      ? {}
      : { hardHaltErrorName: operatorErrorName(hardHaltError) }
    if (context.stage === 'position-read') {
      return {
        marketId,
        status: 'halted' as const,
        stage: context.stage,
        strategyInvalidated,
        errorName: operatorErrorName(context.error),
        invalidationErrorName: operatorErrorName(invalidationError),
        ...cleanupFailure
      }
    }
    return {
      marketId,
      status: 'halted' as const,
      stage: context.stage,
      action: 'invalidate' as const,
      reason: context.reason,
      strategyInvalidated,
      invalidationErrorName: operatorErrorName(invalidationError),
      ...cleanupFailure
    }
  }

  private async haltStrategy(
    marketId: Hex,
    stage: 'configuration' | 'reference-read' | 'decision',
    failure: unknown,
    reason: 'reference-read-failed' | 'bootstrap-decision-failed' | 'bootstrap-configuration-failed'
  ) {
    try {
      await this.make.hardHalt({ reason })
      return {
        marketId,
        status: 'halted' as const,
        stage,
        strategyInvalidated: true,
        errorName: operatorErrorName(failure)
      }
    } catch (invalidationError) {
      return {
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
