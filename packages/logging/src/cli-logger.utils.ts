/** Process output writers for CLI results and diagnostics. */
export type CliLoggerOutput = { writeOut(value: string): void; writeError(value: string): void }

/** Operator CLI logger that keeps results on stdout and diagnostics on stderr. */
export type CliLogger = {
  result(value: unknown): void
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
