import type { Hex } from 'viem'

import type {
  BootstrapConfig,
  BootstrapOffer,
  BootstrapPosition,
  BootstrapRate
} from '../domain/position-bootstrap'

import { decidePositionBootstrap } from '../domain/position-bootstrap'

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
      | 'reference-read-failed'
  }): Promise<void>
}

/** Applies one position-bootstrap reconciliation cycle using fresh provider truth. */
export class PositionBootstrapService {
  private readonly completedMarkets = new Set<Hex>()

  constructor(
    private readonly positions: BootstrapPositionService,
    private readonly rates: BootstrapReferenceRateService,
    private readonly make: BootstrapMakeService,
    private readonly configs: readonly BootstrapConfig[]
  ) {}

  async runOnce() {
    const results = []
    for (const config of this.configs) {
      let position: Awaited<ReturnType<BootstrapPositionService['readPosition']>>
      try {
        position = await this.positions.readPosition(config.marketId)
      } catch (error) {
        results.push(
          await this.failedRead(config.marketId, 'position-read', error, 'market-read-failed')
        )
        continue
      }
      let rate: BootstrapRate
      try {
        rate = await this.rates.readRate(config.marketId)
      } catch (error) {
        results.push(
          await this.failedRead(config.marketId, 'reference-read', error, 'reference-read-failed')
        )
        continue
      }
      const decision = decidePositionBootstrap({
        config,
        position,
        rate,
        activeOffer: position.activeOffer,
        initialTargetCompleted: this.completedMarkets.has(config.marketId)
      })

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
            errorName: error instanceof Error ? error.name : 'UnknownError'
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
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
        continue
      }
      results.push({ marketId: config.marketId, status: 'applied' as const, action: decision.kind })
    }
    return results
  }

  private async failedRead(
    marketId: Hex,
    stage: 'position-read' | 'reference-read',
    readError: unknown,
    reason: 'market-read-failed' | 'reference-read-failed'
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
}
