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
 * JSON-line structured logger. Each call emits a single `{ ...base, ...fields, level, event }` line.
 * `event` is one of the stable keys documented in the bot's observability table. Lines below
 * `minLevel` are dropped; every level goes to stderr, because stdout is reserved as the data
 * plane — the JSON-Lines wire records (see {@link ./records}) — that the pipeline stages exchange.
 *
 * `base` is a set of fields stamped on every line so a process can bind its stage context once
 * (e.g. `{ bot, op, chainId }`) and have every log line carry the correlation keys the pipeline
 * joins on. Per-call `fields` override a colliding base field; `level` and `event` are written
 * LAST so neither `base` nor `fields` can overwrite the reserved discriminants (a stray
 * `{ event }` in context would otherwise silently misclassify the line).
 */
export function createLogger(
  minLevel: LogLevel = 'info',
  base: Record<string, unknown> = {}
): Logger {
  const threshold = LEVEL_RANK[minLevel]
  const emit =
    (level: LogLevel) =>
    (event: string, fields: Record<string, unknown> = {}) => {
      if (LEVEL_RANK[level] < threshold) return
      console.error(JSON.stringify({ ...base, ...fields, level, event }, replacer))
    }
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') }
}
