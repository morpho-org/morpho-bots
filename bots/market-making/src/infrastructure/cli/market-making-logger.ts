type LoggerOutput = { writeOut(value: string): void; writeError(value: string): void }

const serializeJson = (value: unknown, pretty = false) =>
  JSON.stringify(
    value,
    (_key, nested) => (typeof nested === 'bigint' ? nested.toString() : nested),
    pretty ? 2 : undefined
  )

const formatHuman = (value: unknown) =>
  typeof value === 'string' ? value : serializeJson(value, true)

/** Operator logger that keeps results on stdout and diagnostics on stderr. */
type MarketMakingLogger = {
  result(value: unknown): void
  error(message: string, details?: unknown): void
}

/**
 * Creates a CLI logger with human-readable output by default and JSON Lines when requested.
 * @param output - Process output writers.
 * @param json - Whether every emitted record must be machine-parseable JSON.
 * @returns A logger that preserves stdout for results and stderr for failures.
 */
export const createMarketMakingLogger = (
  output: LoggerOutput,
  json: boolean
): MarketMakingLogger => ({
  result: value => output.writeOut(json ? serializeJson(value) : formatHuman(value)),
  error: (message, details) => {
    if (json) {
      output.writeError(
        serializeJson({
          level: 'error',
          event: 'market-making.error',
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
