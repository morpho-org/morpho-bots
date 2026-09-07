const NAME_PATTERN = /^[\w$-]{1,64}/

/**
 * Reduces one OpenTelemetry diagnostic message to a loggable classification token.
 * @param message - Untrusted diagnostic text from the OpenTelemetry SDK.
 * @returns The leading identifier-like token, or a fixed fallback when none exists.
 * @remarks SDK diagnostics can embed endpoint URLs and response bodies, so everything after the
 * first token is dropped rather than scrubbed, and the token itself stops at any dot, colon, or
 * slash so no hostname fragment survives. The token keeps failures distinguishable (for example
 * `OTLPExporterError`) without shipping any part of the free-form message.
 */
export const diagnosticErrorName = (message: unknown) => {
  if (typeof message !== 'string') return 'OtelDiagnostic'
  return NAME_PATTERN.exec(message.trimStart())?.[0] ?? 'OtelDiagnostic'
}
