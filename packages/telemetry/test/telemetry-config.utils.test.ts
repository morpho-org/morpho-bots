import { describe, expect, test } from 'vitest'

import {
  hasMetricExportConfig,
  hasTelemetryConfig,
  hasTraceExportConfig
} from '../src/telemetry-config.utils'

describe('telemetry config detection', () => {
  test('is disabled with no exporter variables', () => {
    expect(hasTelemetryConfig({})).toBe(false)
    expect(hasTraceExportConfig({})).toBe(false)
    expect(hasMetricExportConfig({})).toBe(false)
  })

  test('a blank endpoint does not enable anything', () => {
    expect(hasTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' })).toBe(false)
  })

  test('the general endpoint enables both signals', () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }
    expect(hasTraceExportConfig(env)).toBe(true)
    expect(hasMetricExportConfig(env)).toBe(true)
    expect(hasTelemetryConfig(env)).toBe(true)
  })

  test('signal-specific endpoints enable only their signal', () => {
    const traces = { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces' }
    expect(hasTraceExportConfig(traces)).toBe(true)
    expect(hasMetricExportConfig(traces)).toBe(false)
    const metrics = { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:4318/v1/metrics' }
    expect(hasTraceExportConfig(metrics)).toBe(false)
    expect(hasMetricExportConfig(metrics)).toBe(true)
    expect(hasTelemetryConfig(metrics)).toBe(true)
  })
})
