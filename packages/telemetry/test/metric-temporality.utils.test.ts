import type { PushMetricExporter } from '@opentelemetry/sdk-metrics'

import { AggregationTemporality, InstrumentType } from '@opentelemetry/sdk-metrics'
import { describe, expect, test, vi } from 'vitest'

import { withDeltaObservableGauges } from '../src/metric-temporality.utils'

describe('withDeltaObservableGauges', () => {
  test('selects delta for observable gauges and defers everything else', () => {
    const inner = {
      export: vi.fn(),
      forceFlush: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
      selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE
    } satisfies PushMetricExporter
    const wrapped = withDeltaObservableGauges(inner)
    expect(wrapped.selectAggregationTemporality?.(InstrumentType.OBSERVABLE_GAUGE)).toBe(
      AggregationTemporality.DELTA
    )
    expect(wrapped.selectAggregationTemporality?.(InstrumentType.COUNTER)).toBe(
      AggregationTemporality.CUMULATIVE
    )
  })

  test('falls back to cumulative when the exporter has no selection', async () => {
    const forceFlush = vi.fn(async () => {})
    const shutdown = vi.fn(async () => {})
    const inner: PushMetricExporter = { export: vi.fn(), forceFlush, shutdown }
    const wrapped = withDeltaObservableGauges(inner)
    expect(wrapped.selectAggregationTemporality?.(InstrumentType.HISTOGRAM)).toBe(
      AggregationTemporality.CUMULATIVE
    )
    await wrapped.forceFlush()
    await wrapped.shutdown()
    expect(forceFlush).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
  })
})
