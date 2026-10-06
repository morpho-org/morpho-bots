import type { Hex } from 'viem'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import {
  BlueBootstrapReferenceRateService,
  StrategyBootstrapReferenceRateService
} from '../../../src/infrastructure/bootstrap/bootstrap-reference-rate.service'
import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'

const marketId = `0x${'11'.repeat(32)}` as const
const secondMarketId = `0x${'22'.repeat(32)}` as const

afterEach(() => vi.useRealTimers())

describe('StrategyBootstrapReferenceRateService', () => {
  test('uses a configured hardcoded target without reading the Blue variable-rate average', async () => {
    let variableReads = 0
    const service = new StrategyBootstrapReferenceRateService(
      BootstrapAdapterError,
      new Map([[marketId, { strategy: 'hardcoded', hardcodedRateBps: 400n }]]),
      {
        readRate: async () => {
          variableReads += 1
          return { mode: 'variable', rateBps: 500n, observationId: 'hour:1' }
        }
      }
    )

    expect(await service.readRate(marketId)).toEqual({
      mode: 'static',
      rateBps: 400n,
      observationId: expect.stringMatching(/^static:400:hour:\d+$/)
    })
    expect(variableReads).toBe(0)
  })

  test('selects variable-rate average and hardcoded targets independently by market', async () => {
    const variableReads: Hex[] = []
    const service = new StrategyBootstrapReferenceRateService(
      BootstrapAdapterError,
      new Map([
        [marketId, { strategy: 'variable_rate_avg' }],
        [secondMarketId, { strategy: 'hardcoded', hardcodedRateBps: 400n }]
      ]),
      {
        readRate: async selectedMarketId => {
          variableReads.push(selectedMarketId)
          return { mode: 'variable', rateBps: 525n, observationId: 'hour:2' }
        }
      }
    )

    expect(await service.readRate(marketId)).toEqual({
      mode: 'variable',
      rateBps: 525n,
      observationId: 'hour:2'
    })
    expect(await service.readRate(secondMarketId)).toEqual({
      mode: 'static',
      rateBps: 400n,
      observationId: expect.stringMatching(/^static:400:hour:\d+$/)
    })
    expect(variableReads).toEqual([marketId])
  })

  test('extends both strategy observations with fresh seconds to maturity when configured', async () => {
    const service = new StrategyBootstrapReferenceRateService(
      BootstrapAdapterError,
      new Map([
        [marketId, { strategy: 'variable_rate_avg' }],
        [secondMarketId, { strategy: 'hardcoded', hardcodedRateBps: 400n }]
      ]),
      { readRate: async () => ({ mode: 'variable', rateBps: 525n, observationId: 'hour:2' }) },
      new Map([
        [marketId, async () => 1_000_000n],
        [secondMarketId, async () => 2_000_000n]
      ])
    )

    expect(await service.readRate(marketId)).toEqual({
      mode: 'variable',
      rateBps: 525n,
      observationId: 'hour:2',
      secondsToMaturity: 1_000_000n
    })
    expect(await service.readRate(secondMarketId)).toMatchObject({
      mode: 'static',
      rateBps: 400n,
      secondsToMaturity: 2_000_000n
    })
  })

  test('omits seconds to maturity for markets without a configured maturity read', async () => {
    const service = new StrategyBootstrapReferenceRateService(
      BootstrapAdapterError,
      new Map([[marketId, { strategy: 'variable_rate_avg' }]]),
      { readRate: async () => ({ mode: 'variable', rateBps: 525n, observationId: 'hour:2' }) },
      new Map([[secondMarketId, async () => 1_000_000n]])
    )

    expect(await service.readRate(marketId)).toEqual({
      mode: 'variable',
      rateBps: 525n,
      observationId: 'hour:2'
    })
  })

  test('propagates a failed maturity read instead of quoting without the premium input', async () => {
    const service = new StrategyBootstrapReferenceRateService(
      BootstrapAdapterError,
      new Map([[marketId, { strategy: 'hardcoded', hardcodedRateBps: 400n }]]),
      { readRate: async () => ({ mode: 'variable', rateBps: 525n, observationId: 'hour:2' }) },
      new Map([
        [
          marketId,
          async () => {
            throw new BootstrapAdapterError('reference-checkpoint')
          }
        ]
      ])
    )

    const error = await service.readRate(marketId).catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'reference-checkpoint' })
  })

  test('changes a hardcoded observation when its hourly refresh bucket advances', async () => {
    const service = new StrategyBootstrapReferenceRateService(
      BootstrapAdapterError,
      new Map([[marketId, { strategy: 'hardcoded', hardcodedRateBps: 400n }]]),
      { readRate: async () => ({ mode: 'variable', rateBps: 500n, observationId: 'hour:1' }) }
    )

    vi.setSystemTime(new Date(3_599_000))
    const first = await service.readRate(marketId)
    vi.setSystemTime(new Date(3_600_000))
    const second = await service.readRate(marketId)

    expect(first.observationId).toBe('static:400:hour:0')
    expect(second.observationId).toBe('static:400:hour:1')
  })
})

describe('BlueBootstrapReferenceRateService', () => {
  test('accepts a latest checkpoint at the freshness boundary', async () => {
    const service = new BlueBootstrapReferenceRateService(
      BootstrapAdapterError,
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

  test('subtracts exactly the configured window from the latest checkpoint', async () => {
    const requested: bigint[] = []
    const reader = {
      readLatest: async () => ({
        blockNumber: 200n,
        timestamp: 1_000_000n,
        supplyAssetsPerWadShares: 1_100_000_000_000_000_000n
      }),
      readAtOrBefore: async (target: bigint) => {
        requested.push(target)
        return {
          blockNumber: 100n,
          timestamp: 900_000n,
          supplyAssetsPerWadShares: 1_000_000_000_000_000_000n
        }
      }
    }
    const now = () => 1_000_000n

    await new BlueBootstrapReferenceRateService(
      BootstrapAdapterError,
      reader,
      259_200n,
      now
    ).readRate(marketId)
    await new BlueBootstrapReferenceRateService(
      BootstrapAdapterError,
      reader,
      21_600n,
      now
    ).readRate(marketId)

    expect(requested).toEqual([1_000_000n - 259_200n, 1_000_000n - 21_600n])
  })

  test('derives the historical checkpoint from the latest checkpoint head', async () => {
    const latest = {
      blockNumber: 200n,
      timestamp: 1_000_000n,
      supplyAssetsPerWadShares: 1_100_000_000_000_000_000n
    }
    const heads: unknown[] = []
    const reader = {
      readLatest: async () => latest,
      readAtOrBefore: async (_target: bigint, head: unknown) => {
        heads.push(head)
        return {
          blockNumber: 100n,
          timestamp: 900_000n,
          supplyAssetsPerWadShares: 1_000_000_000_000_000_000n
        }
      }
    }

    await new BlueBootstrapReferenceRateService(
      BootstrapAdapterError,
      reader,
      21_600n,
      () => 1_000_000n
    ).readRate(marketId)

    expect(heads).toEqual([expect.objectContaining({ blockNumber: 200n, timestamp: 1_000_000n })])
  })

  test('rejects a latest checkpoint older than the wall-clock freshness bound', async () => {
    let historicalRead = false
    const service = new BlueBootstrapReferenceRateService(
      BootstrapAdapterError,
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
  test('reports a rejected checkpoint as the calling workflow adapter error', async () => {
    const checkpoint = { blockNumber: 200n, timestamp: 100n, supplyAssetsPerWadShares: 1n }
    const service = new BlueBootstrapReferenceRateService(
      LadderAdapterError,
      { readLatest: async () => checkpoint, readAtOrBefore: async () => checkpoint },
      21_600n,
      () => 401n
    )

    const error = await service.readRate(marketId).catch(value => value)

    expect(error).toBeInstanceOf(LadderAdapterError)
    expect(error).toMatchObject({ name: 'LadderAdapterError', operation: 'reference-stale' })
  })
})
