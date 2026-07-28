import type { Hex } from 'viem'

import { describe, expect, mock, test } from 'bun:test'

import type {
  BootstrapMakeService,
  BootstrapPositionService,
  BootstrapReferenceRateService
} from '../../src/application/position-bootstrap.service'
import type { BootstrapConfig } from '../../src/domain/position-bootstrap'

import { PositionBootstrapService } from '../../src/application/position-bootstrap.service'

const marketId: Hex = `0x${'11'.repeat(32)}`
const secondMarketId: Hex = `0x${'22'.repeat(32)}`

const config = (id = marketId, autoRefill = false): BootstrapConfig => ({
  marketId: id,
  creditTarget: 1_000n,
  acceptanceAssets: 100n,
  offerSize: 500n,
  premiumBps: -50n,
  maximumMarketExposure: 2_000n,
  maximumTotalExposure: 4_000n,
  autoRefill
})

const setup = ({
  configs = [config()],
  credit = 0n
}: {
  configs?: BootstrapConfig[]
  credit?: bigint
} = {}) => {
  const readPosition = mock(async () => ({
    credit,
    debt: 0n,
    cashBalance: 2_000n,
    marketExposure: 0n,
    totalExposure: 0n,
    activeOffer: undefined
  }))
  const readRate = mock(async () => ({
    mode: 'static' as const,
    rateBps: 500n,
    observationId: 'static:500'
  }))
  const reconcile = mock(async () => undefined)
  const positions: BootstrapPositionService = { readPosition }
  const rates: BootstrapReferenceRateService = { readRate }
  const make: BootstrapMakeService = { reconcile }
  const service = new PositionBootstrapService(positions, rates, make, configs)

  return { service, positions, rates, make, readPosition, readRate, reconcile }
}

describe('PositionBootstrapService', () => {
  test('publishes the capped desired offer from fresh position and reference reads', async () => {
    const { service, readPosition, readRate, reconcile } = setup()

    const result = await service.runOnce()

    expect(readPosition).toHaveBeenCalledWith(marketId)
    expect(readRate).toHaveBeenCalledWith(marketId)
    expect(reconcile).toHaveBeenCalledWith({
      marketId,
      desiredOffer: {
        marketId,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      },
      reason: 'publish'
    })
    expect(result).toEqual([
      {
        marketId,
        status: 'applied',
        action: 'publish'
      }
    ])
  })
  test('invalidates at target and stays observational after completion when auto-refill is off', async () => {
    const { service, positions, reconcile } = setup()
    let cycle = 0
    positions.readPosition = mock(async () => {
      cycle += 1
      return {
        credit: cycle === 1 ? 900n : 500n,
        debt: 0n,
        cashBalance: 2_000n,
        marketExposure: 0n,
        totalExposure: 0n,
        activeOffer:
          cycle === 1
            ? {
                marketId,
                assets: 100n,
                rateBps: 450n,
                referenceObservationId: 'static:500'
              }
            : undefined
      }
    })

    const targetResult = await service.runOnce()
    const deficitResult = await service.runOnce()

    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledWith({
      marketId,
      desiredOffer: undefined,
      reason: 'target-reached'
    })
    expect(targetResult).toEqual([{ marketId, status: 'applied', action: 'invalidate' }])
    expect(deficitResult).toEqual([
      { marketId, status: 'observed', action: 'auto-refill-disabled' }
    ])
  })

  test('invalidates a failed market read and continues bootstrapping other markets', async () => {
    const { service, positions, reconcile } = setup({
      configs: [config(), config(secondMarketId)]
    })
    positions.readPosition = mock(async id => {
      if (id === marketId) throw new Error('provider unavailable')
      return {
        credit: 0n,
        debt: 0n,
        cashBalance: 2_000n,
        marketExposure: 0n,
        totalExposure: 0n,
        activeOffer: undefined
      }
    })

    const result = await service.runOnce()

    expect(reconcile).toHaveBeenNthCalledWith(1, {
      marketId,
      desiredOffer: undefined,
      reason: 'market-read-failed'
    })
    expect(reconcile).toHaveBeenNthCalledWith(2, {
      marketId: secondMarketId,
      desiredOffer: {
        marketId: secondMarketId,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      },
      reason: 'publish'
    })
    expect(result).toEqual([
      {
        marketId,
        status: 'failed',
        stage: 'position-read',
        invalidated: true,
        errorName: 'Error'
      },
      { marketId: secondMarketId, status: 'applied', action: 'publish' }
    ])
  })

  test('reports an invalidation failure without hiding the original position read failure', async () => {
    const { service, positions, make } = setup()
    positions.readPosition = mock(async () => {
      throw new TypeError('position unavailable')
    })
    make.reconcile = mock(async () => {
      throw new RangeError('invalidation reverted')
    })

    const result = await service.runOnce()

    expect(result).toEqual([
      {
        marketId,
        status: 'failed',
        stage: 'position-read',
        invalidated: false,
        errorName: 'TypeError',
        invalidationErrorName: 'RangeError'
      }
    ])
  })

  test('invalidates the market when its reference read fails', async () => {
    const { service, rates, reconcile } = setup()
    rates.readRate = mock(async () => {
      throw new TypeError('stale reference')
    })

    const result = await service.runOnce()

    expect(reconcile).toHaveBeenCalledWith({
      marketId,
      desiredOffer: undefined,
      reason: 'reference-read-failed'
    })
    expect(result).toEqual([
      {
        marketId,
        status: 'failed',
        stage: 'reference-read',
        invalidated: true,
        errorName: 'TypeError'
      }
    ])
  })

  test('does not assume publication after a make failure and continues other markets', async () => {
    const { service, make } = setup({ configs: [config(), config(secondMarketId)] })
    make.reconcile = mock(async request => {
      if (request.marketId === marketId) throw new RangeError('publish rejected')
    })

    const result = await service.runOnce()

    expect(result).toEqual([
      {
        marketId,
        status: 'failed',
        stage: 'make',
        invalidated: false,
        errorName: 'RangeError'
      },
      { marketId: secondMarketId, status: 'applied', action: 'publish' }
    ])
  })

  test('resumes after initial completion when auto-refill is enabled', async () => {
    const { service, positions, reconcile } = setup({ configs: [config(marketId, true)] })
    let cycle = 0
    positions.readPosition = mock(async () => {
      cycle += 1
      return {
        credit: cycle === 1 ? 900n : 500n,
        debt: 0n,
        cashBalance: 2_000n,
        marketExposure: 0n,
        totalExposure: 0n,
        activeOffer: undefined
      }
    })

    expect(await service.runOnce()).toEqual([
      { marketId, status: 'observed', action: 'target-reached' }
    ])
    expect(await service.runOnce()).toEqual([{ marketId, status: 'applied', action: 'publish' }])
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
})
