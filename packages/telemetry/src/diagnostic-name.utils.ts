const TOKEN_PATTERN = /^[\w$-]{1,64}/
const ERROR_CLASS_PATTERN = /^[A-Z][A-Za-z0-9]{0,58}(?:Error|Exception)$/

/**
 * Reduces one OpenTelemetry diagnostic message to a loggable classification token.
 * @param message - Untrusted diagnostic text from the OpenTelemetry SDK.
 * @returns The leading error-class-shaped token, or a fixed fallback for everything else.
 * @remarks SDK diagnostics can embed endpoint URLs and response bodies, so truncation alone is
 * not a sanitization boundary: the leading token is kept only when it is shaped like an error
 * class (`OTLPExporterError`, `AbortError`) — a capitalized identifier ending in `Error` or
 * `Exception` — which hostnames, keys, and response fragments do not match. Everything else
 * collapses to `OtelDiagnostic`.
 */
export const diagnosticErrorName = (message: unknown) => {
  if (typeof message !== 'string') return 'OtelDiagnostic'
  const token = TOKEN_PATTERN.exec(message.trimStart())?.[0]
  return token !== undefined && ERROR_CLASS_PATTERN.test(token) ? token : 'OtelDiagnostic'
}
