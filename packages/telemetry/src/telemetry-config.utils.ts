/** Environment map read for the OpenTelemetry export opt-in variables. */
export type Environment = Record<string, string | undefined>

const isSet = (value: string | undefined) => Boolean(value?.trim())

/**
 * Detects an OpenTelemetry trace-export opt-in.
 * @param env - Environment holding the standard OTLP exporter variables.
 * @returns Whether the general or the traces-specific OTLP endpoint is set and non-blank.
 */
export const hasTraceExportConfig = (env: Environment) =>
  isSet(env.OTEL_EXPORTER_OTLP_ENDPOINT) || isSet(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)

/**
 * Detects an OpenTelemetry metric-export opt-in.
 * @param env - Environment holding the standard OTLP exporter variables.
 * @returns Whether the general or the metrics-specific OTLP endpoint is set and non-blank.
 */
export const hasMetricExportConfig = (env: Environment) =>
  isSet(env.OTEL_EXPORTER_OTLP_ENDPOINT) || isSet(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT)

/**
 * Detects any complete OpenTelemetry export opt-in.
 * @param env - Environment holding the standard OTLP exporter variables.
 * @returns Whether at least one telemetry signal has a configured OTLP endpoint.
 * @remarks Endpoint values may embed access tokens, so callers must never log them; this predicate
 * exists so opt-in detection needs no access to the values themselves.
 */
export const hasTelemetryConfig = (env: Environment) =>
  hasTraceExportConfig(env) || hasMetricExportConfig(env)
