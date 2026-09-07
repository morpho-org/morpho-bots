import type { PushMetricExporter } from '@opentelemetry/sdk-metrics'

import { AggregationTemporality, InstrumentType } from '@opentelemetry/sdk-metrics'

/**
 * Wraps a metric exporter so observable gauges use delta temporality.
 * @param exporter - Exporter whose export, flush, and shutdown behavior is delegated unchanged.
 * @returns The same exporter surface with delta temporality selected for observable gauges only.
 * @remarks Under cumulative temporality the SDK re-exports the last value of an attribute set an
 * observable-gauge callback has stopped reporting, so a series meant to disappear (an emptied
 * book's rate) freezes at its final value instead. Delta temporality drops unreported sets, and
 * the wire format is unchanged: an OTLP gauge data point carries no temporality field. Every
 * other instrument keeps the wrapped exporter's own temporality selection.
 */
export const withDeltaObservableGauges = (exporter: PushMetricExporter): PushMetricExporter => ({
  export: (metrics, resultCallback) => exporter.export(metrics, resultCallback),
  forceFlush: () => exporter.forceFlush(),
  shutdown: () => exporter.shutdown(),
  selectAggregationTemporality: instrumentType =>
    instrumentType === InstrumentType.OBSERVABLE_GAUGE
      ? AggregationTemporality.DELTA
      : (exporter.selectAggregationTemporality?.(instrumentType) ??
        AggregationTemporality.CUMULATIVE)
})
