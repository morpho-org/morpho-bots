import type { Hex } from 'viem'

import type { LadderConfig, LadderMarketState, LadderQuoteSet } from '../../domain/ladder/ladder'

import { generateLadder, shouldRecenter, validateLadderConfig } from '../../domain/ladder/ladder'
import { operatorErrorName } from '../operator-error-name.utils'
import { sameLadderQuoteSet } from './ladder-market-maker.utils'

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
   * @param parameters - Market, optional exact desired set, and stable reconciliation reason.
   * @returns `logged` when a dry-run records the request; otherwise completion after reconciliation.
   * @throws When publication, replacement, or invalidation does not settle successfully.
   */
  reconcile(parameters: {
    marketId: Hex
    desired?: LadderQuoteSet
    reason: 'publish' | 'recenter' | 'resize' | 'rest' | 'market-read-failed'
  }): Promise<void | 'logged'>
  /**
   * Invalidates all strategy-owned roots after an unsafe cycle-level failure.
   * @param parameters - Stable safety reason without provider-controlled text.
   * @returns `logged` when a dry-run records the halt; otherwise completion after invalidation.
   * @throws When complete strategy-root invalidation cannot be confirmed.
   */
  hardHalt(parameters: {
    reason:
      | 'ladder-configuration-failed'
      | 'reference-read-failed'
      | 'ladder-decision-failed'
      | 'market-invalidation-failed'
  }): Promise<void | 'logged'>
}

type LadderRunResult =
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
  | { marketId: Hex; status: 'failed'; stage: 'reconcile'; invalidated: false; errorName: string }
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

/** Coordinates deterministic ladder decisions through fresh read and explicit make outcomes. */
export class LadderMarketMakerService {
  /**
   * Creates one ladder application coordinator.
   * @param positions - Fresh position/capacity reader.
   * @param rates - Fresh reference-rate reader.
   * @param make - Blocking reconciliation and hard-halt writer.
   * @param configs - Ordered per-market ladder configurations.
   */
  constructor(
    private readonly positions: LadderPositionService,
    private readonly rates: LadderReferenceRateService,
    private readonly make: LadderMakeService,
    private readonly configs: readonly LadderConfig[]
  ) {}

  /**
   * Preflights every config, then reconciles one fresh cycle for each configured market.
   * @returns Ordered outcomes; dry-run make requests are `logged`, never `applied`.
   * @throws Never for handled config, provider, decision, or invalidation failures.
   * @remarks Retains an active center inside the inclusive movement tolerance while still deriving
   * fresh sizes. All publication and invalidation side effects pass exclusively through `make`.
   */
  async runOnce() {
    for (const config of this.configs) {
      try {
        validateLadderConfig(config)
      } catch (error) {
        return [
          await this.halt(config.marketId, 'configuration', error, 'ladder-configuration-failed')
        ]
      }
    }

    const results: LadderRunResult[] = []
    for (const config of this.configs) {
      let market: LadderMarketState
      try {
        market = await this.positions.readMarket(config.marketId)
      } catch (error) {
        try {
          const invalidation = await this.make.reconcile({
            marketId: config.marketId,
            desired: undefined,
            reason: 'market-read-failed'
          })

          results.push({
            marketId: config.marketId,
            status: 'failed',
            stage: 'market-read',
            invalidated: invalidation !== 'logged',
            ...(invalidation === 'logged' ? { invalidationLogged: true } : {}),
            errorName: operatorErrorName(error)
          })
          continue
        } catch (invalidationError) {
          results.push(
            await this.halt(
              config.marketId,
              'market-invalidation',
              error,
              'market-invalidation-failed',
              invalidationError
            )
          )
          return results
        }
      }

      let referenceRateBps: bigint
      try {
        referenceRateBps = await this.rates.readRate(config.marketId)
      } catch (error) {
        results.push(
          await this.halt(config.marketId, 'reference-read', error, 'reference-read-failed')
        )
        return results
      }

      let desired: LadderQuoteSet
      let reason: 'publish' | 'recenter' | 'resize' | 'rest'
      try {
        const active = await this.make.readActive(config.marketId)
        const effectiveCenter = referenceRateBps + config.quotePremiumBps
        const freshDesired = generateLadder({ config, referenceRateBps, capacities: market })
        const recenter = active
          ? shouldRecenter(active.centerRateBps, effectiveCenter, config.movementToleranceBps)
          : true
        desired =
          active && !recenter
            ? generateLadder({
                config,
                referenceRateBps,
                capacities: market,
                retainedCenterRateBps: active.centerRateBps
              })
            : freshDesired
        if (!active) reason = 'publish'
        else if (sameLadderQuoteSet(active, desired)) reason = 'rest'
        else reason = recenter ? 'recenter' : 'resize'
      } catch (error) {
        results.push(await this.halt(config.marketId, 'decision', error, 'ladder-decision-failed'))
        return results
      }

      let reconciliation: void | 'logged'
      try {
        reconciliation = await this.make.reconcile({ marketId: config.marketId, desired, reason })
      } catch (error) {
        results.push({
          marketId: config.marketId,
          status: 'failed',
          stage: 'reconcile',
          invalidated: false,
          errorName: operatorErrorName(error)
        })
        continue
      }
      if (reason === 'rest') {
        results.push({ marketId: config.marketId, status: 'observed', action: 'rest' })
        continue
      }
      results.push({
        marketId: config.marketId,
        status: reconciliation === 'logged' ? 'logged' : 'applied',
        action: reason === 'publish' ? 'publish' : 'replace',
        reason
      })
    }
    return results
  }

  private async halt(
    marketId: Hex,
    stage: Extract<LadderRunResult, { status: 'halted' }>['stage'],
    error: unknown,
    reason: Parameters<LadderMakeService['hardHalt']>[0]['reason'],
    marketInvalidationError?: unknown
  ): Promise<LadderRunResult> {
    const marketInvalidationFailure =
      marketInvalidationError === undefined
        ? {}
        : { marketInvalidationErrorName: operatorErrorName(marketInvalidationError) }
    try {
      const invalidation = await this.make.hardHalt({ reason })
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
