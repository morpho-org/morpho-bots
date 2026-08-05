import { describe, expect, test } from 'vitest'

import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { BlueBootstrapReferenceRateService } from '../../../src/infrastructure/bootstrap/bootstrap-reference-rate.service'

const marketId = `0x${'11'.repeat(32)}` as const

describe('BlueBootstrapReferenceRateService', () => {
  test('accepts a latest checkpoint at the freshness boundary', async () => {
    const service = new BlueBootstrapReferenceRateService(
      {
        readLatest: async () => ({
          blockNumber: 200n,
          timestamp: 100n,
          supplyAssetsPerWadShares: 1_100_000_000_000_000_000n
        }),
        readAtOrBefore: async () => ({
          blockNumber: 100n,
          timestamp: 50n,
          supplyAssetsPerWadShares: 1_000_000_000_000_000_000n
        })
      },
      21_600n,
      () => 400n
    )

    expect(await service.readRate(marketId)).toMatchObject({
      mode: 'variable',
      observationId: 'hour:0'
    })
  })

  test('rejects a latest checkpoint older than the wall-clock freshness bound', async () => {
    let historicalRead = false
    const service = new BlueBootstrapReferenceRateService(
      {
        readLatest: async () => ({
          blockNumber: 200n,
          timestamp: 100n,
          supplyAssetsPerWadShares: 1_100_000_000_000_000_000n
        }),
        readAtOrBefore: async () => {
          historicalRead = true
          return {
            blockNumber: 100n,
            timestamp: 50n,
            supplyAssetsPerWadShares: 1_000_000_000_000_000_000n
          }
        }
      },
      21_600n,
      () => 401n
    )

    const error = await service.readRate(marketId).catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'reference-stale' })
    expect(historicalRead).toBe(false)
  })
})
