import type { ResourceMetrics } from '@opentelemetry/sdk-metrics'

import { metrics } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics'
import { withDeltaObservableGauges } from '@repo/telemetry'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { createTelemetryRecordObserver } from '../../../src/infrastructure/observability/telemetry-metrics.utils'

const MARKET_ID = '0x5555555555555555555555555555555555555555555555555555555555555555' as const

type CollectedMetric = {
  name: string
  dataPoints: { attributes: Record<string, unknown>; value: unknown }[]
}

describe('createTelemetryRecordObserver', () => {
  let exporter: InMemoryMetricExporter
  let provider: MeterProvider

  beforeEach(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
    provider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          // The production wrapper is part of the behavior under test: without delta temporality
          // for observable gauges, the SDK re-exports an emptied book's stale rates.
          exporter: withDeltaObservableGauges(exporter),
          exportIntervalMillis: 3_600_000
        })
      ]
    })
    metrics.setGlobalMeterProvider(provider)
  })

  afterEach(async () => {
    await provider.shutdown()
    metrics.disable()
  })

  const collect = async (): Promise<CollectedMetric[]> => {
    await provider.forceFlush()
    return exporter
      .getMetrics()
      .flatMap((resourceMetrics: ResourceMetrics) => resourceMetrics.scopeMetrics)
      .flatMap(scopeMetrics => scopeMetrics.metrics)
      .map(metric => ({
        name: metric.descriptor.name,
        dataPoints: metric.dataPoints.map(dataPoint => ({
          attributes: dataPoint.attributes,
          value: dataPoint.value
        }))
      }))
  }

  const metricByName = (collected: CollectedMetric[], name: string) =>
    collected.find(metric => metric.name === name)

  test('maps cycle results to a counter and a duration histogram', async () => {
    const observer = createTelemetryRecordObserver()
    observer.record({
      event: 'cycle.completed',
      workflow: 'ladder',
      marketId: MARKET_ID,
      status: 'applied',
      action: 'recenter',
      durationMs: 1234,
      errorName: 'ShouldNeverBecomeAnAttribute'
    })
    const collected = await collect()
    expect(metricByName(collected, 'quoter_bot.cycles')?.dataPoints).toEqual([
      {
        attributes: {
          workflow: 'ladder',
          marketId: MARKET_ID,
          status: 'applied',
          action: 'recenter'
        },
        value: 1
      }
    ])
    const duration = metricByName(collected, 'quoter_bot.cycle.duration')?.dataPoints[0]
    expect(duration?.attributes).toEqual({ workflow: 'ladder', status: 'applied' })
    expect(duration?.value).toMatchObject({ count: 1, sum: 1234 })
  })

  test('maps guardrails, transactions, fills, and setup checks to counters', async () => {
    const observer = createTelemetryRecordObserver()
    observer.record({
      event: 'guardrail.rate-clamped',
      workflow: 'ladder',
      marketId: MARKET_ID,
      side: 'higher',
      clampedRungs: 2,
      bound: 'maximum',
      minimumRateBps: 200n,
      maximumRateBps: 800n
    })
    observer.record({
      event: 'ladder.transaction-submitted',
      operation: 'publish',
      marketId: MARKET_ID,
      txHash: '0xdeadbeef'
    })
    observer.record({
      event: 'transaction.settled',
      workflow: 'ladder',
      marketId: MARKET_ID,
      operation: 'publish',
      txHash: '0xdeadbeef'
    })
    observer.record({
      event: 'offer.consumed',
      marketId: MARKET_ID,
      side: 'lower',
      consumedDeltaAssets: 250_000_000n,
      groupRateBps: 400n,
      remainingAssets: 750_000_000n,
      groupId: '0x8888888888888888888888888888888888888888888888888888888888888888'
    })
    observer.record({ event: 'setup.check-failed', check: 'native-balance', status: 'failed' })

    const collected = await collect()
    expect(metricByName(collected, 'quoter_bot.guardrail.events')?.dataPoints).toEqual([
      {
        attributes: {
          type: 'rate-clamped',
          workflow: 'ladder',
          marketId: MARKET_ID,
          side: 'higher',
          bound: 'maximum'
        },
        value: 1
      }
    ])
    expect(metricByName(collected, 'quoter_bot.transactions')?.dataPoints).toEqual([
      {
        attributes: {
          phase: 'submitted',
          workflow: 'ladder',
          operation: 'publish',
          marketId: MARKET_ID
        },
        value: 1
      },
      {
        attributes: {
          phase: 'settled',
          workflow: 'ladder',
          operation: 'publish',
          marketId: MARKET_ID
        },
        value: 1
      }
    ])
    expect(metricByName(collected, 'quoter_bot.offers.consumed_assets')?.dataPoints).toEqual([
      { attributes: { marketId: MARKET_ID, side: 'lower' }, value: 250_000_000 }
    ])
    expect(metricByName(collected, 'quoter_bot.setup.checks')?.dataPoints).toEqual([
      { attributes: { check: 'native-balance', status: 'failed' }, value: 1 }
    ])
  })

  test('maps observations to gauges with bigint conversion', async () => {
    const observer = createTelemetryRecordObserver()
    observer.record({
      event: 'reference.observed',
      workflow: 'bootstrap',
      marketId: MARKET_ID,
      referenceRateBps: 412n,
      targetRateBps: 362n
    })
    observer.record({
      event: 'position.observed',
      marketId: MARKET_ID,
      cashBalanceAssets: 10_000_000_000n,
      creditAssets: 2_500_000_000n
    })
    observer.record({
      event: 'book.observed',
      marketId: MARKET_ID,
      side: 'higher',
      state: 'quoting',
      rungs: 3,
      totalAssets: 1_500_000_000n,
      bestRateBps: 420n
    })
    observer.record({
      event: 'bootstrap.progress',
      marketId: MARKET_ID,
      creditAssets: 1_000_000n,
      creditTargetAssets: 10_000_000n
    })

    const collected = await collect()
    expect(metricByName(collected, 'quoter_bot.reference.rate_bps')?.dataPoints).toEqual([
      { attributes: { workflow: 'bootstrap', marketId: MARKET_ID }, value: 412 }
    ])
    expect(metricByName(collected, 'quoter_bot.reference.target_rate_bps')?.dataPoints).toEqual([
      { attributes: { workflow: 'bootstrap', marketId: MARKET_ID }, value: 362 }
    ])
    expect(metricByName(collected, 'quoter_bot.position.cash_balance_assets')?.dataPoints).toEqual([
      { attributes: { marketId: MARKET_ID }, value: 10_000_000_000 }
    ])
    expect(metricByName(collected, 'quoter_bot.position.reserved_assets')).toBeUndefined()
    expect(metricByName(collected, 'quoter_bot.book.quoting')?.dataPoints).toEqual([
      { attributes: { marketId: MARKET_ID, side: 'higher' }, value: 1 }
    ])
    expect(metricByName(collected, 'quoter_bot.book.best_rate_bps')?.dataPoints).toEqual([
      { attributes: { marketId: MARKET_ID, side: 'higher' }, value: 420 }
    ])
    expect(
      metricByName(collected, 'quoter_bot.bootstrap.credit_target_assets')?.dataPoints
    ).toEqual([{ attributes: { marketId: MARKET_ID }, value: 10_000_000 }])
  })

  test('an empty book drops its rate data points instead of freezing them', async () => {
    const OTHER_MARKET_ID =
      '0x6666666666666666666666666666666666666666666666666666666666666666' as const
    const observer = createTelemetryRecordObserver()
    observer.record({
      event: 'book.observed',
      marketId: MARKET_ID,
      side: 'higher',
      state: 'quoting',
      rungs: 3,
      totalAssets: 1_500_000_000n,
      bestRateBps: 420n,
      centerRateBps: 400n
    })
    observer.record({
      event: 'book.observed',
      marketId: OTHER_MARKET_ID,
      side: 'lower',
      state: 'quoting',
      rungs: 2,
      totalAssets: 500_000_000n,
      centerRateBps: 380n
    })
    const beforeEmpty = await collect()
    expect(metricByName(beforeEmpty, 'quoter_bot.book.best_rate_bps')?.dataPoints).toEqual([
      { attributes: { marketId: MARKET_ID, side: 'higher' }, value: 420 }
    ])

    observer.record({
      event: 'book.observed',
      marketId: MARKET_ID,
      side: 'higher',
      state: 'empty',
      rungs: 0,
      totalAssets: 0n
    })
    exporter.reset()
    const afterEmpty = await collect()
    expect(metricByName(afterEmpty, 'quoter_bot.book.best_rate_bps')?.dataPoints ?? []).toEqual([])
    expect(metricByName(afterEmpty, 'quoter_bot.book.center_rate_bps')?.dataPoints).toEqual([
      { attributes: { marketId: OTHER_MARKET_ID, side: 'lower' }, value: 380 }
    ])
    expect(metricByName(afterEmpty, 'quoter_bot.book.quoting')?.dataPoints).toEqual([
      { attributes: { marketId: MARKET_ID, side: 'higher' }, value: 0 },
      { attributes: { marketId: OTHER_MARKET_ID, side: 'lower' }, value: 1 }
    ])
  })

  test('never emits trace-only correlation fields or error names as attributes', async () => {
    const observer = createTelemetryRecordObserver()
    observer.record({
      event: 'cycle.completed',
      workflow: 'ladder',
      status: 'failed',
      errorName: 'LadderAdapterError'
    })
    observer.record({
      event: 'ladder.transaction-submitted',
      operation: 'cancel',
      txHash: '0xfeedface'
    })
    observer.record({
      event: 'offer.consumed',
      marketId: MARKET_ID,
      side: 'lower',
      consumedDeltaAssets: 1n,
      groupRateBps: 1n,
      remainingAssets: 1n,
      groupId: '0x9999999999999999999999999999999999999999999999999999999999999999'
    })
    const attributeKeys = (await collect())
      .flatMap(metric => metric.dataPoints)
      .flatMap(dataPoint => Object.keys(dataPoint.attributes))
    expect(attributeKeys).not.toContain('txHash')
    expect(attributeKeys).not.toContain('groupId')
    expect(attributeKeys).not.toContain('errorName')
  })

  test('malformed records never throw', async () => {
    const observer = createTelemetryRecordObserver()
    for (const record of [
      undefined,
      null,
      42,
      'cycle.completed',
      [],
      { event: 7 },
      { event: 'cycle.completed' },
      { event: 'position.observed', marketId: MARKET_ID, cashBalanceAssets: 'not-a-number' },
      { event: 'book.observed', marketId: MARKET_ID }
    ]) {
      expect(() => observer.record(record)).not.toThrow()
    }
  })
})
