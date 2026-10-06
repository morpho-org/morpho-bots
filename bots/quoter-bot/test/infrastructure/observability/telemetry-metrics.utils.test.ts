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

import type { LadderRunResult } from '../../../src/application/ladder/ladder-quoter.service'

import { ladderMonitoringEvents } from '../../../src/application/monitoring/ladder-monitoring.utils'
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
    expect(duration?.attributes).toEqual({
      workflow: 'ladder',
      status: 'applied',
      marketId: MARKET_ID
    })
    expect(duration?.value).toMatchObject({ count: 1, sum: 1234 })
  })

  test('counts a batched submission sharing one hash as one transaction', async () => {
    const observer = createTelemetryRecordObserver()
    for (const groupId of ['0xaa', '0xbb', '0xcc']) {
      observer.record({
        event: 'offer-invalidation.transaction-submitted',
        groupId,
        txHash: '0xsamehash'
      })
    }
    observer.record({
      event: 'ladder.transaction-submitted',
      operation: 'publish',
      marketId: MARKET_ID,
      txHash: '0xotherhash'
    })
    const submitted = metricByName(await collect(), 'quoter_bot.transactions')
      ?.dataPoints.filter(dataPoint => dataPoint.attributes.phase === 'submitted')
      .map(dataPoint => ({ workflow: dataPoint.attributes.workflow, value: dataPoint.value }))
    expect(submitted).toEqual([
      { workflow: 'offer-invalidation', value: 1 },
      { workflow: 'ladder', value: 1 }
    ])
  })

  test('maps guardrails, transactions, fills, and setup checks to counters', async () => {
    const observer = createTelemetryRecordObserver()
    observer.record({
      event: 'guardrail.rate-omitted',
      workflow: 'ladder',
      marketId: MARKET_ID,
      side: 'higher',
      omittedRungs: 2,
      omittedAssets: 7n,
      bound: 'maximum',
      outermostRateBps: 950n,
      minimumRateBps: 200n,
      maximumRateBps: 800n
    })
    observer.record({
      event: 'guardrail.book-crossed',
      workflow: 'ladder',
      marketId: MARKET_ID,
      side: 'lower',
      clearable: true,
      suppressed: false
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
      consumedDeltaUnits: 250_000_000n,
      groupRateBps: 400n,
      remainingUnits: 750_000_000n,
      groupId: '0x8888888888888888888888888888888888888888888888888888888888888888'
    })
    observer.record({ event: 'setup.check-failed', check: 'native-balance', status: 'failed' })
    observer.record({
      event: 'transaction.lifecycle',
      state: 'replaced',
      nonce: 7,
      txHash: '0xnew',
      previousTxHash: '0xold',
      attempt: 2
    })

    const collected = await collect()
    expect(metricByName(collected, 'quoter_bot.guardrail.events')?.dataPoints).toEqual([
      {
        attributes: {
          type: 'rate-omitted',
          workflow: 'ladder',
          marketId: MARKET_ID,
          side: 'higher',
          bound: 'maximum'
        },
        value: 1
      },
      {
        attributes: {
          type: 'book-crossed',
          workflow: 'ladder',
          marketId: MARKET_ID,
          side: 'lower',
          clearable: true,
          suppressed: false
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
    expect(metricByName(collected, 'quoter_bot.offers.consumed_units')?.dataPoints).toEqual([
      { attributes: { marketId: MARKET_ID, side: 'lower' }, value: 250_000_000 }
    ])
    expect(metricByName(collected, 'quoter_bot.setup.checks')?.dataPoints).toEqual([
      { attributes: { check: 'native-balance', status: 'failed' }, value: 1 }
    ])
    expect(metricByName(collected, 'quoter_bot.transaction.lifecycle')?.dataPoints).toEqual([
      { attributes: { state: 'replaced' }, value: 1 }
    ])
  })

  test('zeroes total units when a quoting book side empties with no active quote', async () => {
    const observer = createTelemetryRecordObserver()
    const project = (activeQuote?: object) =>
      ladderMonitoringEvents([
        {
          marketId: MARKET_ID,
          status: 'observed',
          action: 'rest',
          verbose: {
            config: { marketId: MARKET_ID },
            currentState: { status: 'observed', market: {} },
            stateAfterCheck: {
              status: 'observed',
              market: {},
              ...(activeQuote ? { activeQuote } : {})
            }
          }
        } as unknown as LadderRunResult
      ])
    const quote = {
      centerRateBps: 500n,
      lower: [{ rateBps: 450n, assets: 100n }],
      higher: [{ rateBps: 550n, assets: 40n }]
    }
    for (const event of project(quote)) observer.record(event)
    expect(metricByName(await collect(), 'quoter_bot.book.total_units')?.dataPoints).toEqual([
      { attributes: { marketId: MARKET_ID, side: 'lower' }, value: 100 },
      { attributes: { marketId: MARKET_ID, side: 'higher' }, value: 40 }
    ])

    for (const event of project()) observer.record(event)
    exporter.reset()

    expect(metricByName(await collect(), 'quoter_bot.book.total_units')?.dataPoints).toEqual([
      { attributes: { marketId: MARKET_ID, side: 'lower' }, value: 0 },
      { attributes: { marketId: MARKET_ID, side: 'higher' }, value: 0 }
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
      totalUnits: 1_500_000_000n,
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
      totalUnits: 1_500_000_000n,
      bestRateBps: 420n,
      centerRateBps: 400n
    })
    observer.record({
      event: 'book.observed',
      marketId: OTHER_MARKET_ID,
      side: 'lower',
      state: 'quoting',
      rungs: 2,
      totalUnits: 500_000_000n,
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
      totalUnits: 0n
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

  test('a projected one-sided quote removes every empty-side rate', async () => {
    const observer = createTelemetryRecordObserver()
    const project = (higher: { rateBps: bigint; assets: bigint }[]) =>
      ladderMonitoringEvents([
        {
          marketId: MARKET_ID,
          status: 'observed',
          action: 'rest',
          verbose: {
            config: { marketId: MARKET_ID },
            currentState: {
              status: 'observed',
              market: {},
              activeQuote: {
                centerRateBps: 500n,
                lower: [{ rateBps: 450n, assets: 100n }],
                higher
              }
            },
            stateAfterCheck: { status: 'failed', errorName: 'ProviderReadError' }
          }
        } as unknown as LadderRunResult
      ])
    for (const event of project([{ rateBps: 550n, assets: 100n }])) observer.record(event)
    const before = await collect()
    expect(metricByName(before, 'quoter_bot.book.center_rate_bps')?.dataPoints).toEqual([
      { attributes: { marketId: MARKET_ID, side: 'lower' }, value: 500 },
      { attributes: { marketId: MARKET_ID, side: 'higher' }, value: 500 }
    ])

    const oneSided = project([])
    expect(oneSided).toContainEqual({
      event: 'book.observed',
      marketId: MARKET_ID,
      side: 'higher',
      state: 'empty',
      rungs: 0,
      totalUnits: 0n,
      centerRateBps: 500n
    })
    for (const event of oneSided) observer.record(event)
    exporter.reset()
    const after = await collect()
    expect(metricByName(after, 'quoter_bot.book.center_rate_bps')?.dataPoints).toEqual([
      { attributes: { marketId: MARKET_ID, side: 'lower' }, value: 500 }
    ])
    for (const name of ['best_rate_bps', 'worst_rate_bps']) {
      expect(metricByName(after, `quoter_bot.book.${name}`)?.dataPoints).toEqual([
        { attributes: { marketId: MARKET_ID, side: 'lower' }, value: 450 }
      ])
    }
    expect(metricByName(after, 'quoter_bot.book.quoting')?.dataPoints).toEqual([
      { attributes: { marketId: MARKET_ID, side: 'lower' }, value: 1 },
      { attributes: { marketId: MARKET_ID, side: 'higher' }, value: 0 }
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
      consumedDeltaUnits: 1n,
      groupRateBps: 1n,
      remainingUnits: 1n,
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

  test('counts lend halts by direction and gauges which markets are halted', async () => {
    const observer = createTelemetryRecordObserver()
    observer.record({
      event: 'guardrail.lend-halted',
      workflow: 'ladder',
      marketId: MARKET_ID,
      lossFactor: 6n,
      acceptedLossFactor: 5n,
      defaulted: false,
      direction: 'above',
      incrementalLossBps: 1n
    })
    observer.record({
      event: 'cycle.completed',
      workflow: 'ladder',
      marketId: MARKET_ID,
      status: 'applied',
      action: 'lend-halted'
    })
    observer.record({
      event: 'cycle.completed',
      workflow: 'bootstrap',
      marketId: MARKET_ID,
      status: 'observed',
      action: 'rest'
    })
    observer.record({
      event: 'cycle.completed',
      workflow: 'bootstrap',
      marketId: MARKET_ID,
      status: 'failed',
      stage: 'guard-read'
    })
    const collected = await collect()

    expect(metricByName(collected, 'quoter_bot.guardrail.events')?.dataPoints).toEqual([
      {
        attributes: {
          type: 'lend-halted',
          workflow: 'ladder',
          marketId: MARKET_ID,
          direction: 'above'
        },
        value: 1
      }
    ])
    expect(metricByName(collected, 'quoter_bot.market.lend_halted')?.dataPoints).toEqual([
      { attributes: { workflow: 'ladder', marketId: MARKET_ID }, value: 1 },
      { attributes: { workflow: 'bootstrap', marketId: MARKET_ID }, value: 0 }
    ])
  })

  test('gauges a market as halted when its cancellation failed', async () => {
    const observer = createTelemetryRecordObserver()
    observer.record({
      event: 'cycle.completed',
      workflow: 'ladder',
      marketId: MARKET_ID,
      status: 'halted',
      stage: 'market-invalidation',
      reason: 'loss-factor-mismatch'
    })
    observer.record({
      event: 'guardrail.lend-halted',
      workflow: 'ladder',
      marketId: MARKET_ID,
      lossFactor: 6n,
      acceptedLossFactor: 5n,
      defaulted: false,
      direction: 'above'
    })

    expect(metricByName(await collect(), 'quoter_bot.market.lend_halted')?.dataPoints).toEqual([
      { attributes: { workflow: 'ladder', marketId: MARKET_ID }, value: 1 }
    ])
  })

  test('gauges a market as halted when admission withheld a buy for its loss factor', async () => {
    const observer = createTelemetryRecordObserver()
    observer.record({
      event: 'cycle.completed',
      workflow: 'bootstrap',
      marketId: MARKET_ID,
      status: 'applied',
      action: 'publication-withheld',
      reason: 'loss-factor-mismatch'
    })

    expect(metricByName(await collect(), 'quoter_bot.market.lend_halted')?.dataPoints).toEqual([
      { attributes: { workflow: 'bootstrap', marketId: MARKET_ID }, value: 1 }
    ])
  })

  test('gauges the inventory skew and counts a price-changed withholding', async () => {
    const observer = createTelemetryRecordObserver()
    observer.record({
      event: 'inventory-skew.observed',
      workflow: 'ladder',
      marketId: MARKET_ID,
      inventorySkewBps: 40n,
      skewClamped: false,
      creditAssets: 1_000n,
      neutralCredit: 0n
    })
    observer.record({
      event: 'guardrail.publication-withheld',
      workflow: 'ladder',
      marketId: MARKET_ID,
      reason: 'price-changed'
    })

    const collected = await collect()
    expect(metricByName(collected, 'quoter_bot.market.inventory_skew_bps')?.dataPoints).toEqual([
      { attributes: { workflow: 'ladder', marketId: MARKET_ID }, value: 40 }
    ])
    expect(metricByName(collected, 'quoter_bot.guardrail.events')?.dataPoints).toEqual([
      {
        attributes: {
          type: 'publication-withheld',
          workflow: 'ladder',
          marketId: MARKET_ID,
          reason: 'price-changed'
        },
        value: 1
      }
    ])
  })
})
