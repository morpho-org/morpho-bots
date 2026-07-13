export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type Logger = Record<LogLevel, (event: string, fields?: Record<string, unknown>) => void>

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

// JSON.stringify throws on bigint, and the stable event keys carry bigints (nonce, gas,
// block number, seized/repaid amounts). Emit them as flat decimal strings so a log line never
// fails to serialize and downstream tooling reads them losslessly. (Intentionally NOT the
// `bigintReplacer` from @repo/utils, which wraps values as `{ __bigint__: "7" }` for round-trip
// parsing — log aggregators want the bare string, not a tagged object.)
function replacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value
}

/**
 * JSON-line structured logger. Each call emits a single `{ level, event, ...fields }` line.
 * `event` is one of the stable keys documented in the bot's observability table. Lines below
 * `minLevel` are dropped; every level goes to stderr, because stdout is reserved as the data
 * plane — the JSON-Lines wire records (see {@link ./records}) — that the pipeline stages exchange.
 */
export function createLogger(minLevel: LogLevel = 'info'): Logger {
  const threshold = LEVEL_RANK[minLevel]
  const emit =
    (level: LogLevel) =>
    (event: string, fields: Record<string, unknown> = {}) => {
      if (LEVEL_RANK[level] < threshold) return
      console.error(JSON.stringify({ level, event, ...fields }, replacer))
    }
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') }
}
