import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { TargetRateStrategyConfig } from '../../../src/domain/target-rate'
import type {
  BlueReferenceReader,
  BlueSupplyCheckpoint
} from '../../../src/infrastructure/reference/reference-rates'

import { ReferenceAdapterError } from '../../../src/errors'
import { createReferenceRates } from '../../../src/infrastructure/reference/reference-rates'

const marketId: Hex = `0x${'11'.repeat(32)}`
const secondMarketId: Hex = `0x${'22'.repeat(32)}`
const WAD = 1_000_000_000_000_000_000n

const checkpoint = (timestamp: bigint, supply: bigint): BlueSupplyCheckpoint => ({
  blockNumber: timestamp,
  timestamp,
  supplyAssetsPerWadShares: supply
})

/** A Blue history whose latest checkpoint is at `latest`, counting every read it serves. */
const blue = (latest = 1_000_000n, overrides: Partial<BlueReferenceReader> = {}) => {
  const reads = { latest: 0, history: [] as { target: bigint; head: unknown }[] }
  const reader: BlueReferenceReader = {
    readLatest: async () => {
      reads.latest += 1
      return checkpoint(latest, (WAD * 11n) / 10n)
    },
    readAtOrBefore: async (target, head) => {
      reads.history.push({ target, head })
      return checkpoint(latest - 100_000n, WAD)
    },
    ...overrides
  }
  return { reader, reads }
}

const rates = (
  parameters: {
    ladder?: readonly [Hex, TargetRateStrategyConfig][]
    bootstrap?: readonly [Hex, TargetRateStrategyConfig][]
    reader?: BlueReferenceReader
    lookbackSeconds?: bigint
    nowSeconds?: bigint
  } = {}
) =>
  createReferenceRates({
    targets: {
      ladder: new Map(parameters.ladder ?? []),
      bootstrap: new Map(parameters.bootstrap ?? [])
    },
    reader: parameters.reader ?? blue().reader,
    lookbackSeconds: parameters.lookbackSeconds ?? 21_600n,
    nowSeconds: () => parameters.nowSeconds ?? 1_000_000n
  })

const variable = { strategy: 'variable_rate_avg' } as const
const hardcoded = (rateBps: bigint) =>
  ({ strategy: 'hardcoded', hardcodedRateBps: rateBps }) as const

describe('createReferenceRates', () => {
  test('selects each strategy target independently, even for one market', async () => {
    const history = blue()
    const read = rates({
      ladder: [[marketId, hardcoded(475n)]],
      bootstrap: [[marketId, variable]],
      reader: history.reader
    })

    const [ladder, bootstrap] = await read([
      { strategy: 'ladder', marketId },
      { strategy: 'bootstrap', marketId }
    ])

    expect(ladder).toEqual({
      ok: true,
      value: { mode: 'static', rateBps: 475n, observationId: 'static:475:hour:277' }
    })
    expect(bootstrap).toMatchObject({
      ok: true,
      value: { mode: 'variable', observationId: 'hour:277' }
    })
  })

  test('shares one Blue history read across every variable-rate market of a call', async () => {
    const history = blue()
    const read = rates({
      ladder: [
        [marketId, variable],
        [secondMarketId, variable]
      ],
      bootstrap: [[marketId, variable]],
      reader: history.reader
    })

    const readings = await read([
      { strategy: 'ladder', marketId },
      { strategy: 'ladder', marketId: secondMarketId },
      { strategy: 'bootstrap', marketId }
    ])

    expect(readings.every(reading => reading.ok)).toBe(true)
    expect(history.reads.latest).toBe(1)
    expect(history.reads.history).toHaveLength(1)
  })

  test('reads no Blue history when every requested target is hardcoded', async () => {
    const history = blue()
    await rates({ ladder: [[marketId, hardcoded(475n)]], reader: history.reader })([
      { strategy: 'ladder', marketId }
    ])

    expect(history.reads.latest).toBe(0)
  })

  test('changes a hardcoded observation when its hourly refresh bucket advances', async () => {
    const at = async (nowSeconds: bigint) =>
      (
        await rates({ ladder: [[marketId, hardcoded(400n)]], nowSeconds })([
          { strategy: 'ladder', marketId }
        ])
      )[0]

    expect(await at(3_599n)).toMatchObject({ value: { observationId: 'static:400:hour:0' } })
    expect(await at(3_600n)).toMatchObject({ value: { observationId: 'static:400:hour:1' } })
  })

  test('subtracts exactly the configured window from the latest checkpoint, at its head', async () => {
    const history = blue()
    await rates({
      ladder: [[marketId, variable]],
      reader: history.reader,
      lookbackSeconds: 259_200n
    })([{ strategy: 'ladder', marketId }])

    expect(history.reads.history).toEqual([
      {
        target: 1_000_000n - 259_200n,
        head: expect.objectContaining({ blockNumber: 1_000_000n, timestamp: 1_000_000n })
      }
    ])
  })

  test('annualizes the supply-share growth over the elapsed window', async () => {
    const [reading] = await rates({ ladder: [[marketId, variable]] })([
      { strategy: 'ladder', marketId }
    ])

    expect(reading).toEqual({
      ok: true,
      value: {
        mode: 'variable',
        rateBps: ((WAD / 10n) * 31_536_000n * 10_000n) / 100_000n / WAD,
        observationId: 'hour:277'
      }
    })
  })

  test('accepts a latest checkpoint at the freshness boundary and rejects one past it', async () => {
    const at = async (nowSeconds: bigint) => {
      const history = blue(1_000_000n)
      const readings = await rates({
        ladder: [[marketId, variable]],
        bootstrap: [[marketId, variable]],
        reader: history.reader,
        nowSeconds
      })([
        { strategy: 'ladder', marketId },
        { strategy: 'bootstrap', marketId }
      ])
      return { readings, history }
    }

    expect((await at(1_000_300n)).readings.every(reading => reading.ok)).toBe(true)
    const { readings: stale, history } = await at(1_000_301n)
    expect(stale).toEqual([
      { ok: false, errorName: 'LadderAdapterError', adapterOperation: 'reference-stale' },
      { ok: false, errorName: 'BootstrapAdapterError', adapterOperation: 'reference-stale' }
    ])
    expect(history.reads.history).toEqual([])
  })

  test('accepts a checkpoint up to one second ahead of the host clock and rejects one further ahead', async () => {
    const at = async (nowSeconds: bigint) =>
      rates({ ladder: [[marketId, variable]], reader: blue(1_000_000n).reader, nowSeconds })([
        { strategy: 'ladder', marketId }
      ])

    expect((await at(999_999n)).every(reading => reading.ok)).toBe(true)
    expect(await at(999_998n)).toEqual([
      { ok: false, errorName: 'LadderAdapterError', adapterOperation: 'reference-stale' }
    ])
  })

  test('names a rejected checkpoint as the calling strategy names its failures', async () => {
    const flat = checkpoint(1_000_000n, WAD)
    const [ladder, bootstrap] = await rates({
      ladder: [[marketId, variable]],
      bootstrap: [[marketId, variable]],
      reader: { readLatest: async () => flat, readAtOrBefore: async () => flat }
    })([
      { strategy: 'ladder', marketId },
      { strategy: 'bootstrap', marketId }
    ])

    expect(ladder).toEqual({
      ok: false,
      errorName: 'LadderAdapterError',
      adapterOperation: 'reference-checkpoint'
    })
    expect(bootstrap).toEqual({
      ok: false,
      errorName: 'BootstrapAdapterError',
      adapterOperation: 'reference-checkpoint'
    })
  })

  test('keeps a failed history read as each variable market failure, and hardcoded ones ready', async () => {
    const [ladder, bootstrap] = await rates({
      ladder: [[marketId, variable]],
      bootstrap: [[marketId, hardcoded(400n)]],
      reader: blue(1_000_000n, {
        readLatest: async () => {
          throw new ReferenceAdapterError('latest-block')
        }
      }).reader
    })([
      { strategy: 'ladder', marketId },
      { strategy: 'bootstrap', marketId }
    ])

    expect(ladder).toEqual({
      ok: false,
      errorName: 'ReferenceAdapterError',
      adapterOperation: 'latest-block'
    })
    expect(bootstrap).toMatchObject({ ok: true, value: { mode: 'static', rateBps: 400n } })
  })

  test('fails a market with no configured target', async () => {
    expect(await rates()([{ strategy: 'bootstrap', marketId }])).toEqual([
      {
        ok: false,
        errorName: 'BootstrapAdapterError',
        adapterOperation: 'target-rate-strategy-missing'
      }
    ])
  })
})
