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
  decidePositionBootstrapTransition
} from '../domain/position-bootstrap'

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'UnknownError')

export interface BootstrapPositionService {
  readPosition(marketId: Hex): Promise<
    BootstrapPosition & {
      debt: bigint
      activeOffer?: BootstrapOffer
    }
  >
}

export interface BootstrapReferenceRateService {
  readRate(marketId: Hex): Promise<BootstrapRate>
}

export interface BootstrapMakeService {
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
  hardHalt(parameters: {
    reason: 'reference-read-failed' | 'bootstrap-decision-failed'
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
      stage: 'reference-read' | 'decision'
      strategyInvalidated: boolean
      errorName: string
      invalidationErrorName?: string
    }

/** Applies position-bootstrap cycles. Its in-memory one-shot gate resets on service recreation. */
export class PositionBootstrapService {
  private readonly completedMarkets = new Set<Hex>()

  constructor(
    private readonly positions: BootstrapPositionService,
    private readonly rates: BootstrapReferenceRateService,
    private readonly make: BootstrapMakeService,
    private readonly configs: readonly BootstrapConfig[]
  ) {}

  async runOnce() {
    const results: BootstrapRunResult[] = []
    for (const config of this.configs) {
      let position: Awaited<ReturnType<BootstrapPositionService['readPosition']>>
      try {
        position = await this.positions.readPosition(config.marketId)
      } catch (error) {
        results.push(
          await this.failedMarketRead(config.marketId, 'position-read', error, 'market-read-failed')
        )
        continue
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
        results.push(
          await this.haltStrategy(config.marketId, 'decision', error, 'bootstrap-decision-failed')
        )
        return results
      }
      let decision: PositionBootstrapDecision

      if (transition) {
        decision = transition
      } else {
        let rate: BootstrapRate
        try {
          rate = await this.rates.readRate(config.marketId)
        } catch (error) {
          results.push(
            await this.haltStrategy(
              config.marketId,
              'reference-read',
              error,
              'reference-read-failed'
            )
          )
          return results
        }

        try {
          decision = decidePositionBootstrap({
            config,
            position,
            rate,
            activeOffer: position.activeOffer,
            initialTargetCompleted: this.completedMarkets.has(config.marketId)
          })
        } catch (error) {
          results.push(
            await this.haltStrategy(config.marketId, 'decision', error, 'bootstrap-decision-failed')
          )
          return results
        }
      }

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
          results.push({
            marketId: config.marketId,
            status: 'failed' as const,
            stage: 'make' as const,
            invalidated: false,
            errorName: errorName(error)
          })
          continue
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
          errorName: errorName(error)
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
  ) {
    try {
      await this.make.reconcile({ marketId, desiredOffer: undefined, reason })
      return {
        marketId,
        status: 'failed' as const,
        stage,
        invalidated: true,
        errorName: errorName(readError)
      }
    } catch (invalidationError) {
      return {
        marketId,
        status: 'failed' as const,
        stage,
        invalidated: false,
        errorName: errorName(readError),
        invalidationErrorName: errorName(invalidationError)
      }
    }
  }

  private async haltStrategy(
    marketId: Hex,
    stage: 'reference-read' | 'decision',
    failure: unknown,
    reason: 'reference-read-failed' | 'bootstrap-decision-failed'
  ) {
    try {
      await this.make.hardHalt({ reason })
      return {
        marketId,
        status: 'halted' as const,
        stage,
        strategyInvalidated: true,
        errorName: errorName(failure)
      }
    } catch (invalidationError) {
      return {
        marketId,
        status: 'halted' as const,
        stage,
        strategyInvalidated: false,
        errorName: errorName(failure),
        invalidationErrorName: errorName(invalidationError)
      }
    }
  }
}
