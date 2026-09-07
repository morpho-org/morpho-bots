const TOKEN_PATTERN = /^[\w$-]{1,64}/

const KNOWN_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  'AbortError',
  'AggregateError',
  'Error',
  'EvalError',
  'OTLPExporterError',
  'RangeError',
  'ReferenceError',
  'SocketError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'URIError'
])

/**
 * Reduces one OpenTelemetry diagnostic message to a loggable classification token.
 * @param message - Untrusted diagnostic text from the OpenTelemetry SDK.
 * @returns The leading token when it is on the fixed classification allowlist, else a constant.
 * @remarks SDK diagnostics can embed endpoint URLs, response bodies, and credentials, so neither
 * truncation nor shape validation is a sanitization boundary — an adversarial fragment can look
 * exactly like an error-class name (`SecretError`). Only the enumerated classifications the SDK
 * and undici actually raise pass through verbatim; every other message, whatever its shape,
 * collapses to `OtelDiagnostic`.
 */
export const diagnosticErrorName = (message: unknown) => {
  if (typeof message !== 'string') return 'OtelDiagnostic'
  const token = TOKEN_PATTERN.exec(message.trimStart())?.[0]
  return token !== undefined && KNOWN_CLASSIFICATIONS.has(token) ? token : 'OtelDiagnostic'
}
