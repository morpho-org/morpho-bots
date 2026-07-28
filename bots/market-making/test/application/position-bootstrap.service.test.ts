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
  minimumRateBps: 200n,
  maximumRateBps: 800n,
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
  const hardHalt = mock(async () => undefined)
  const positions: BootstrapPositionService = { readPosition }
  const rates: BootstrapReferenceRateService = { readRate }
  const make: BootstrapMakeService = { reconcile, hardHalt }
  const service = new PositionBootstrapService(positions, rates, make, configs)

  return { service, positions, rates, make, readPosition, readRate, reconcile, hardHalt }
}

describe('PositionBootstrapService', () => {
  test('preflights a positive premium before a target-reached position or reference read', async () => {
    const { service, readPosition, readRate, reconcile, hardHalt } = setup({
      configs: [{ ...config(), premiumBps: 1n }],
      credit: 900n
    })

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'configuration',
        strategyInvalidated: true,
        errorName: 'BootstrapConfigurationError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-configuration-failed' })
    expect(readPosition).not.toHaveBeenCalled()
    expect(readRate).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('preflights a positive premium after auto-refill false completion', async () => {
    const mutableConfig = config()
    const { service, readPosition, readRate, reconcile, hardHalt } = setup({
      configs: [mutableConfig],
      credit: 900n
    })
    expect(await service.runOnce()).toEqual([
      { marketId, status: 'observed', action: 'target-reached' }
    ])
    mutableConfig.premiumBps = 1n
    readPosition.mockClear()

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'configuration',
        strategyInvalidated: true,
        errorName: 'BootstrapConfigurationError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-configuration-failed' })
    expect(readPosition).not.toHaveBeenCalled()
    expect(readRate).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('preflights every market before an earlier valid market can publish', async () => {
    const { service, readPosition, readRate, reconcile, hardHalt } = setup({
      configs: [config(), { ...config(secondMarketId), offerSize: 0n }]
    })

    expect(await service.runOnce()).toEqual([
      {
        marketId: secondMarketId,
        status: 'halted',
        stage: 'configuration',
        strategyInvalidated: true,
        errorName: 'BootstrapConfigurationError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-configuration-failed' })
    expect(readPosition).not.toHaveBeenCalled()
    expect(readRate).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('preserves configuration and cleanup failure evidence during preflight', async () => {
    const { service, make, readPosition, readRate, reconcile } = setup({
      configs: [{ ...config(), maximumTotalExposure: 0n }]
    })
    const hardHalt = mock(async () => {
      throw new RangeError('cleanup reverted')
    })
    make.hardHalt = hardHalt

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'configuration',
        strategyInvalidated: false,
        errorName: 'BootstrapConfigurationError',
        invalidationErrorName: 'RangeError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-configuration-failed' })
    expect(readPosition).not.toHaveBeenCalled()
    expect(readRate).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

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

  test('halts the strategy on a reference failure and prevents later market publication', async () => {
    const { service, rates, reconcile, hardHalt } = setup({
      configs: [config(), config(secondMarketId)]
    })
    rates.readRate = mock(async () => {
      throw new TypeError('stale reference')
    })

    const result = await service.runOnce()

    expect(hardHalt).toHaveBeenCalledWith({
      reason: 'reference-read-failed'
    })
    expect(reconcile).not.toHaveBeenCalled()
    expect(result).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'reference-read',
        strategyInvalidated: true,
        errorName: 'TypeError'
      }
    ])
  })

  test('preserves the reference failure classification when strategy cleanup also fails', async () => {
    const { service, rates, make } = setup()
    rates.readRate = mock(async () => {
      throw new TypeError('stale reference')
    })
    make.hardHalt = mock(async () => {
      throw new RangeError('cleanup reverted')
    })

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'reference-read',
        strategyInvalidated: false,
        errorName: 'TypeError',
        invalidationErrorName: 'RangeError'
      }
    ])
  })

  test('halts and invalidates the strategy when the bootstrap decision rejects active offers', async () => {
    const { service, positions, rates, hardHalt } = setup()
    positions.readPosition = mock(async () => ({
      credit: 0n,
      debt: 0n,
      cashBalance: 2_000n,
      marketExposure: 0n,
      totalExposure: 0n,
      activeOffer: {
        marketId,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      }
    }))
    rates.readRate = mock(async () => ({
      mode: 'static' as const,
      rateBps: 100n,
      observationId: 'static:100'
    }))

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'decision',
        strategyInvalidated: true,
        errorName: 'BootstrapConfigurationError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-decision-failed' })
  })

  test('preflights a negative acceptance threshold before reading a live offer', async () => {
    const { service, positions, readRate, reconcile, hardHalt } = setup({
      configs: [{ ...config(), acceptanceAssets: -1n }, config(secondMarketId)]
    })
    const readPosition = mock(async (id: Hex) => ({
      credit: 0n,
      debt: 0n,
      cashBalance: 2_000n,
      marketExposure: 0n,
      totalExposure: 0n,
      activeOffer: {
        marketId: id,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      }
    }))
    positions.readPosition = readPosition

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'configuration',
        strategyInvalidated: true,
        errorName: 'BootstrapConfigurationError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledTimes(1)
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-configuration-failed' })
    expect(readPosition).not.toHaveBeenCalled()
    expect(readRate).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('preserves cleanup evidence when an excessive acceptance threshold fails preflight', async () => {
    const { service, positions, make, readRate, reconcile } = setup({
      configs: [{ ...config(), acceptanceAssets: 1_001n }, config(secondMarketId)]
    })
    const readPosition = mock(async (id: Hex) => ({
      credit: 0n,
      debt: 0n,
      cashBalance: 2_000n,
      marketExposure: 0n,
      totalExposure: 0n,
      activeOffer: {
        marketId: id,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      }
    }))
    positions.readPosition = readPosition
    const hardHalt = mock(async () => {
      throw new RangeError('cleanup reverted')
    })
    make.hardHalt = hardHalt

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'configuration',
        strategyInvalidated: false,
        errorName: 'BootstrapConfigurationError',
        invalidationErrorName: 'RangeError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledTimes(1)
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-configuration-failed' })
    expect(readPosition).not.toHaveBeenCalled()
    expect(readRate).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('completes before a failed reference read and stays stopped with auto-refill disabled', async () => {
    const { service, positions, rates, reconcile } = setup()
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
    const failedReadRate = mock(async () => {
      throw new TypeError('reference unavailable')
    })
    rates.readRate = failedReadRate

    expect(await service.runOnce()).toEqual([{ marketId, status: 'applied', action: 'invalidate' }])
    expect(await service.runOnce()).toEqual([
      { marketId, status: 'observed', action: 'auto-refill-disabled' }
    ])
    expect(failedReadRate).not.toHaveBeenCalled()
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  test('service recreation intentionally resets the auto-refill false one-shot gate', async () => {
    const first = setup({ credit: 900n })
    expect(await first.service.runOnce()).toEqual([
      { marketId, status: 'observed', action: 'target-reached' }
    ])

    const restarted = setup({ credit: 500n })
    expect(await restarted.service.runOnce()).toEqual([
      { marketId, status: 'applied', action: 'publish' }
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
