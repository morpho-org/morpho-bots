import type { Attributes } from '@opentelemetry/api'

import { context, diag, DiagLogLevel, metrics, propagation, trace } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

import type { Environment } from './telemetry-config.utils'

import { diagnosticErrorName } from './diagnostic-name.utils'
import { withDeltaObservableGauges } from './metric-temporality.utils'
import { withSpanSanitizer } from './span-sanitizer.utils'
import { hasMetricExportConfig, hasTraceExportConfig } from './telemetry-config.utils'
import { redactedUrlAttributes } from './url-redaction.utils'

const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60_000
// Node clamps larger timer delays to 1 ms, which would turn a long cadence into a hot loop.
const MAXIMUM_METRIC_EXPORT_INTERVAL_MS = 2_147_483_647
const SHUTDOWN_TIMEOUT_MS = 10_000
const DIAGNOSTIC_LOG_INTERVAL_MS = 60_000

/** Structural logger accepting sanitized telemetry lifecycle and diagnostic events. */
export type TelemetryLogger = {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
}

/** Lifecycle handle for one process-global OpenTelemetry pipeline. */
export type BotTelemetry = {
  /** Whether any signal exporter was registered; `false` means every telemetry API is a no-op. */
  enabled: boolean
  /**
   * Flushes buffered spans and metrics, then unregisters every global telemetry hook.
   * @returns Completion once exporters have shut down or a bounded timeout has elapsed.
   * @remarks Never rejects; a timed-out or failed shutdown reduces to one sanitized
   * `otel.shutdown-failed` warning. The bound covers only this promise — an in-flight export
   * keeps its own socket until the exporter timeout (`OTEL_EXPORTER_OTLP_TIMEOUT`, default 10 s)
   * and can delay process exit by up to that long. Safe to call when telemetry is disabled and
   * safe to call more than once.
   */
  shutdown(): Promise<void>
}

const metricExportIntervalMs = (env: Environment, logger?: TelemetryLogger) => {
  const raw = env.OTEL_METRIC_EXPORT_INTERVAL?.trim()
  if (!raw) return DEFAULT_METRIC_EXPORT_INTERVAL_MS
  const parsed = Number(raw)
  if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAXIMUM_METRIC_EXPORT_INTERVAL_MS) {
    return parsed
  }
  logger?.warn('otel.invalid-metric-export-interval')
  return DEFAULT_METRIC_EXPORT_INTERVAL_MS
}

const installDiagnosticLogger = (logger: TelemetryLogger | undefined, now: () => number) => {
  if (logger === undefined) return
  let lastLoggedAt = -Infinity
  const error = (message: unknown) => {
    if (now() - lastLoggedAt < DIAGNOSTIC_LOG_INTERVAL_MS) return
    lastLoggedAt = now()
    logger.warn('otel.diagnostic', { errorName: diagnosticErrorName(message) })
  }
  const ignore = () => {}
  diag.setLogger(
    { error, warn: ignore, info: ignore, debug: ignore, verbose: ignore },
    DiagLogLevel.ERROR
  )
}

const bounded = async <Result>(task: Promise<Result>, timeoutMs: number) => {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([task, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Starts the process-global OpenTelemetry pipeline when an OTLP export opt-in is present.
 * @param options - Service identity, extra resource attributes, and testable environment and
 * logger overrides.
 * @returns The enabled state and an idempotent flushing shutdown handle.
 * @remarks Telemetry is strictly opt-in and strictly best-effort: without a configured OTLP
 * endpoint nothing is registered, and no failure — during startup, export, or shutdown — ever
 * throws past this boundary or interrupts the bot. Traces and metrics register independently —
 * each gated by the standard `OTEL_EXPORTER_OTLP_ENDPOINT` or its signal-specific variant, and
 * each isolated at startup, so one signal's failed registration (reported as a per-signal
 * `otel.start-failed`) never suppresses the other — and export over OTLP/HTTP with JSON encoding. Outbound undici/fetch requests are auto-instrumented
 * through `diagnostics_channel` (bundle-safe, unlike module patching) with every URL-bearing span
 * attribute reduced to its origin, because RPC URLs commonly embed credentials. SDK diagnostics
 * are reduced to a rate-limited sanitized classification; endpoint values are never logged.
 * `OTEL_SERVICE_NAME` overrides the configured service name, matching SDK convention. The `env`
 * override drives opt-in detection, service naming, and interval parsing only — the OTLP
 * exporters always read the standard `OTEL_EXPORTER_OTLP_*` variables from the process
 * environment.
 */
export const startBotTelemetry = (options: {
  serviceName: string
  serviceVersion?: string
  attributes?: Attributes
  env?: Environment
  logger?: TelemetryLogger
  now?: () => number
}): BotTelemetry => {
  const env = options.env ?? process.env
  const tracesEnabled = hasTraceExportConfig(env)
  const metricsEnabled = hasMetricExportConfig(env)
  const noop = { enabled: false, shutdown: async () => {} }
  if (!tracesEnabled && !metricsEnabled) return noop

  const startSignal = <Registered>(
    signal: string,
    start: () => Registered,
    cleanup: () => void
  ): Registered | undefined => {
    try {
      return start()
    } catch (error) {
      options.logger?.warn('otel.start-failed', {
        signal,
        errorName: diagnosticErrorName(error instanceof Error ? error.name : error)
      })
      cleanup()
      return undefined
    }
  }

  try {
    installDiagnosticLogger(options.logger, options.now ?? Date.now)
    const serviceName = env.OTEL_SERVICE_NAME?.trim() || options.serviceName
    const resource = defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        ...(options.serviceVersion === undefined
          ? {}
          : { [ATTR_SERVICE_VERSION]: options.serviceVersion }),
        ...options.attributes
      })
    )

    const tracerProvider = tracesEnabled
      ? startSignal(
          'traces',
          () => {
            const provider = new NodeTracerProvider({
              resource,
              spanProcessors: [withSpanSanitizer(new BatchSpanProcessor(new OTLPTraceExporter()))]
            })
            provider.register()
            return provider
          },
          () => {
            trace.disable()
            context.disable()
            propagation.disable()
          }
        )
      : undefined

    const meterProvider = metricsEnabled
      ? startSignal(
          'metrics',
          () => {
            const provider = new MeterProvider({
              resource,
              readers: [
                new PeriodicExportingMetricReader({
                  exporter: withDeltaObservableGauges(new OTLPMetricExporter()),
                  exportIntervalMillis: metricExportIntervalMs(env, options.logger)
                })
              ]
            })
            metrics.setGlobalMeterProvider(provider)
            return provider
          },
          () => metrics.disable()
        )
      : undefined

    if (tracerProvider === undefined && meterProvider === undefined) {
      diag.disable()
      return noop
    }

    const undici = startSignal(
      'instrumentation',
      () => {
        const instrumentation = new UndiciInstrumentation({
          startSpanHook: redactedUrlAttributes
        })
        if (tracerProvider) instrumentation.setTracerProvider(tracerProvider)
        if (meterProvider) instrumentation.setMeterProvider(meterProvider)
        return instrumentation
      },
      () => {}
    )

    options.logger?.info('otel.started', {
      serviceName,
      traces: tracerProvider !== undefined,
      metrics: meterProvider !== undefined
    })

    let stopped = false
    return {
      enabled: true,
      shutdown: async () => {
        if (stopped) return
        stopped = true
        try {
          const shutdowns = [tracerProvider, meterProvider]
            .filter(provider => provider !== undefined)
            .map(provider => provider.shutdown())
          undici?.disable()
          const settled = await bounded(Promise.allSettled(shutdowns), SHUTDOWN_TIMEOUT_MS)
          const failure =
            settled === 'timeout'
              ? 'ShutdownTimeout'
              : settled
                  .filter(outcome => outcome.status === 'rejected')
                  .map(outcome =>
                    diagnosticErrorName(
                      outcome.reason instanceof Error ? outcome.reason.name : outcome.reason
                    )
                  )[0]
          if (failure !== undefined) {
            options.logger?.warn('otel.shutdown-failed', { errorName: failure })
          }
        } catch (error) {
          options.logger?.warn('otel.shutdown-failed', {
            errorName: diagnosticErrorName(error instanceof Error ? error.name : error)
          })
        } finally {
          trace.disable()
          metrics.disable()
          context.disable()
          propagation.disable()
          diag.disable()
        }
      }
    }
  } catch (error) {
    options.logger?.warn('otel.start-failed', {
      signal: 'pipeline',
      errorName: diagnosticErrorName(error instanceof Error ? error.name : error)
    })
    trace.disable()
    metrics.disable()
    context.disable()
    propagation.disable()
    diag.disable()
    return noop
  }
}
