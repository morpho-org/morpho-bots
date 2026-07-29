import type { Hex } from 'viem'

import type { LadderConfig, LadderMarketState, LadderQuoteSet } from '../domain/ladder'

import { generateLadder, shouldRecenter, validateLadderConfig } from '../domain/ladder'
import { sameLadderQuoteSet } from './ladder-market-maker.utils'
import { operatorErrorName } from './operator-error-name.utils'

/** Consumer-owned port for fresh position and capacity inputs for one ladder market. */
export interface LadderPositionService {
  /**
   * Reads current side, market, and total capacities.
   * @param marketId - Canonical market identifier to inspect.
   * @returns Fresh capacities used to resize both sides before reconciliation.
   */
  readMarket(marketId: Hex): Promise<LadderMarketState>
}

/** Consumer-owned port for the current reference rate of one ladder market. */
export interface LadderReferenceRateService {
  /**
   * Reads the current fixed-point reference rate.
   * @param marketId - Canonical market identifier whose reference is required.
   * @returns Current rate in integer basis points.
   */
  readRate(marketId: Hex): Promise<bigint>
}

/** Consumer-owned blocking make boundary for ladder reconciliation and safety invalidation. */
export interface LadderMakeService {
  /**
   * Reconciles one strategy-owned market quote set against fresh active roots.
   * @param parameters - Market, optional exact desired set, and stable reconciliation reason.
   * @returns Completion only after blocking reconciliation settles.
   */
  reconcile(parameters: {
    marketId: Hex
    desired?: LadderQuoteSet
    reason: 'publish' | 'recenter' | 'resize' | 'rest' | 'market-read-failed'
  }): Promise<void>
  /**
   * Invalidates all strategy-owned roots after an unsafe cycle-level failure.
   * @param parameters - Stable safety reason without provider-controlled text.
   * @returns Completion after strategy invalidation settles.
   */
  hardHalt(parameters: {
    reason:
      | 'ladder-configuration-failed'
      | 'reference-read-failed'
      | 'ladder-decision-failed'
      | 'market-invalidation-failed'
  }): Promise<void>
}

type LadderRunResult =
  | { marketId: Hex; status: 'observed'; action: 'rest' }
  | {
      marketId: Hex
      status: 'applied'
      action: 'publish' | 'replace'
      reason: 'publish' | 'recenter' | 'resize'
    }
  | { marketId: Hex; status: 'failed'; stage: 'market-read'; invalidated: true; errorName: string }
  | {
      marketId: Hex
      status: 'halted'
      stage: 'configuration' | 'reference-read' | 'decision' | 'market-invalidation'
      strategyInvalidated: boolean
      errorName: string
      invalidationErrorName?: string
    }

/** Coordinates deterministic ladder decisions through fresh read and blocking make ports. */
export class LadderMarketMakerService {
  private readonly activeDesired = new Map<Hex, LadderQuoteSet>()

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
   * @returns Ordered structured outcomes; market-read failures continue, safety halts stop the cycle.
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
          await this.make.reconcile({
            marketId: config.marketId,
            desired: undefined,
            reason: 'market-read-failed'
          })
          this.activeDesired.delete(config.marketId)
          results.push({
            marketId: config.marketId,
            status: 'failed',
            stage: 'market-read',
            invalidated: true,
            errorName: operatorErrorName(error)
          })
          continue
        } catch (invalidationError) {
          results.push(
            await this.halt(
              config.marketId,
              'market-invalidation',
              invalidationError,
              'market-invalidation-failed'
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
        const active = this.activeDesired.get(config.marketId)
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

      try {
        await this.make.reconcile({ marketId: config.marketId, desired, reason })
      } catch (error) {
        results.push(await this.halt(config.marketId, 'decision', error, 'ladder-decision-failed'))
        return results
      }
      this.activeDesired.set(config.marketId, desired)
      if (reason === 'rest') {
        results.push({ marketId: config.marketId, status: 'observed', action: 'rest' })
        continue
      }
      results.push({
        marketId: config.marketId,
        status: 'applied',
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
    reason: Parameters<LadderMakeService['hardHalt']>[0]['reason']
  ): Promise<LadderRunResult> {
    try {
      await this.make.hardHalt({ reason })
      this.activeDesired.clear()
      return {
        marketId,
        status: 'halted',
        stage,
        strategyInvalidated: true,
        errorName: operatorErrorName(error)
      }
    } catch (invalidationError) {
      return {
        marketId,
        status: 'halted',
        stage,
        strategyInvalidated: false,
        errorName: operatorErrorName(error),
        invalidationErrorName: operatorErrorName(invalidationError)
      }
    }
  }
}
