/** Process output writers for CLI results and diagnostics. */
export type CliLoggerOutput = {
  /** Writes one already-formatted line to standard output. @param value - Complete output line. */
  writeOut(value: string): void
  /** Writes one already-formatted line to standard error. @param value - Complete error line. */
  writeError(value: string): void
}

/** Operator CLI logger that keeps results on stdout and diagnostics on stderr. */
export type CliLogger = {
  /**
   * Writes one result to stdout: verbatim strings or pretty JSON, or one JSON line in JSON mode.
   * @param value - Result value; bigints serialize as decimal strings.
   */
  result(value: unknown): void
  /**
   * Writes one failure to stderr, never stdout: `Error: <message>` plus pretty-printed details,
   * or a single `{ level, event, message, details? }` JSON line in JSON mode.
   * @param message - Sanitized operator-facing failure message.
   * @param details - Optional structured report; bigints serialize as decimal strings.
   */
  error(message: string, details?: unknown): void
}

const serializeJson = (value: unknown, pretty = false) =>
  JSON.stringify(
    value,
    (_key, nested) => (typeof nested === 'bigint' ? nested.toString() : nested),
    pretty ? 2 : undefined
  )

const formatHuman = (value: unknown) =>
  typeof value === 'string' ? value : serializeJson(value, true)

/**
 * Creates a CLI logger with human-readable output by default and JSON Lines when requested.
 * @param output - Process output writers.
 * @param options - JSON-mode flag and the caller-owned error event name used for JSON records.
 * @returns A logger that preserves stdout for results and stderr for failures.
 * @remarks Serialization is bigint-safe: bigints become decimal strings in every mode.
 */
export const createCliLogger = (
  output: CliLoggerOutput,
  options: { json: boolean; errorEvent: string }
): CliLogger => ({
  result: value => output.writeOut(options.json ? serializeJson(value) : formatHuman(value)),
  error: (message, details) => {
    if (options.json) {
      output.writeError(
        serializeJson({
          level: 'error',
          event: options.errorEvent,
          message,
          ...(details === undefined ? {} : { details })
        })
      )
      return
    }

    const suffix = details === undefined ? '' : `\n${serializeJson(details, true)}`
    output.writeError(`Error: ${message}${suffix}`)
  }
})
