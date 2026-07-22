import type { LogLayerTransport, LogLayerTransportParams } from 'loglayer'

import { BetterStackTransport } from '@loglayer/transport-betterstack'
import { BlankTransport, LogLayer } from 'loglayer'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type Logger = Record<LogLevel, (event: string, fields?: Record<string, unknown>) => void>

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Fields bound once and stamped onto every line — the wide-log context (e.g. bot, chainId). */
export type LogContext = Record<string, unknown>

export type CreateLoggerOptions = {
  /** Persistent fields stamped onto every line (see {@link LogContext}). */
  context?: LogContext
  /** Env source for the BetterStack opt-in vars; defaults to `process.env`. Injectable for tests. */
  env?: Record<string, string | undefined>
}

// The event keys carry bigints (nonce, gas, block number, seized/repaid amounts) and downstream
// serialization — the stderr line AND the BetterStack transport's own JSON.stringify — throws on a
// raw bigint. Round-trip through JSON with a bigint→decimal-string replacer BEFORE anything reaches
// loglayer: this yields a plain, JSON-safe object (bigints flattened to bare strings at any depth,
// exactly as the old logger emitted) that both sinks can serialize losslessly. (Intentionally NOT
// @repo/utils' `bigintReplacer`, which tags values as `{ __bigint__: "7" }` for round-trip parsing —
// log aggregators want the bare string, not a tagged object.)
function toJsonSafe(fields: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(fields, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  ) as Record<string, unknown>
}

// Railway does not stamp its native identity onto forwarded logs, so replicate what the retired
// Vector VRL did: fold whichever RAILWAY_* vars are present into the context (all absent under
// docker-compose / local dev, so each is optional). Bots spread this into their global context.
export function railwayContext(env: Record<string, string | undefined> = process.env): LogContext {
  const map: Record<string, string | undefined> = {
    railway_service: env.RAILWAY_SERVICE_NAME,
    railway_deployment: env.RAILWAY_DEPLOYMENT_ID,
    railway_environment: env.RAILWAY_ENVIRONMENT_NAME,
    railway_replica: env.RAILWAY_REPLICA_ID
  }
  const context: LogContext = {}
  for (const [key, value] of Object.entries(map)) {
    const trimmed = value?.trim()
    if (trimmed) context[key] = trimmed
  }
  return context
}

/**
 * `07-21 16:42:35` — UTC, stamped onto every stderr line so local runs and Railway's viewer show a
 * scan-friendly event time (Railway's own prefix is nanosecond ISO; local runs get nothing at all).
 * Year deliberately omitted for line width; the shipped BetterStack record keeps its own full `dt`.
 */
function formatTime(date: Date) {
  const iso = date.toISOString()
  return `${iso.slice(5, 10)} ${iso.slice(11, 19)}`
}

// The stderr sink: one `{ level, time, event, ...fields }` JSON line per call, ALL levels to stderr
// (so log capture can never silently miss a level and stdout stays reserved for program output).
// loglayer's built-in console transport reshapes the line, so this custom BlankTransport keeps the
// legacy shape (plus `time`). `data` already carries context + the (bigint-flattened) fields,
// merged by loglayer.
function stderrTransport(): LogLayerTransport {
  return new BlankTransport({
    id: 'stderr',
    shipToLogger: ({ logLevel, messages, data }: LogLayerTransportParams) => {
      const event = messages.map(part => String(part)).join(' ')
      console.error(
        JSON.stringify({ level: logLevel, time: formatTime(new Date()), event, ...data })
      )
      return messages
    }
  })
}

// The BetterStack sink, attached ONLY when both opt-in vars are set (else null → zero network
// activity, no transport, byte-identical stderr behavior). The host is bare
// (e.g. `s1234.eu.betterstackdata.com`), so prepend the scheme the transport's `url` param requires.
// onError writes a single PLAIN stderr line (NOT through loglayer — that would recurse back through
// this same transport). Batching defaults (batchSize 100 / batchSendTimeout 5s), maxRetries 3, and
// respectRateLimit true are all accepted: after retries are exhausted the batch is DROPPED — shipping
// is in-process best-effort and off the tick path, so it must never throw into or block the loop (the
// transport try/catches its own send). There is no public flush() seam, so a few batched lines may be
// lost on process exit — accepted loss.
//
// Opt-in contract (TIB-2026-07-14 "Opt-in contract"): BOTH vars unset ⇒ fully inert (the opt-out).
// But EXACTLY ONE set is a provisioning mistake — a half-configured shipper would silently drop
// external observability while the bot looks healthy — so it FAILS LOUD: a single structured stderr
// line names the missing var. We still return null (ship nothing) rather than throw: the bot must
// never crash over observability config. The warning is written plainly via console.error, like the
// transport's own onError, to avoid recursing back through loglayer.
function betterStackTransport(
  env: Record<string, string | undefined>
): BetterStackTransport | null {
  const sourceToken = env.BETTERSTACK_SOURCE_TOKEN?.trim()
  const host = env.BETTERSTACK_INGESTING_HOST?.trim()
  if (!sourceToken || !host) {
    if (sourceToken || host) {
      const missing = sourceToken ? 'BETTERSTACK_INGESTING_HOST' : 'BETTERSTACK_SOURCE_TOKEN'
      console.error(
        JSON.stringify({
          level: 'error',
          time: formatTime(new Date()),
          event: 'logship.misconfigured',
          detail: `partial BetterStack config: ${missing} is unset — shipping nothing`
        })
      )
    }
    return null
  }
  const url = /^https?:\/\//.test(host) ? host : `https://${host}`
  return new BetterStackTransport({
    sourceToken,
    url,
    onError: error => {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(
        JSON.stringify({
          level: 'error',
          time: formatTime(new Date()),
          event: 'logship.error',
          detail
        })
      )
    }
  })
}

/**
 * JSON-line structured logger. Each call emits a single
 * `{ level, time, event, ...context, ...fields }` line to stderr (`time` is `MM-DD HH:MM:SS` UTC);
 * `event` is one of the stable keys documented in the bot's observability table.
 * Lines below `minLevel` are dropped before they reach any sink. When both `BETTERSTACK_SOURCE_TOKEN`
 * and `BETTERSTACK_INGESTING_HOST` are set, the same records are ALSO shipped to BetterStack
 * in-process (best-effort, off the critical path); unset ⇒ no transport, no network. Bind wide-log
 * context (e.g. `{ bot, chainId }`) via `options.context` so every line carries it.
 */
export function createLogger(
  minLevel: LogLevel = 'info',
  options: CreateLoggerOptions = {}
): Logger {
  const threshold = LEVEL_RANK[minLevel]
  const env = options.env ?? process.env

  const betterStack = betterStackTransport(env)
  const transports: LogLayerTransport[] = betterStack
    ? [stderrTransport(), betterStack]
    : [stderrTransport()]

  const layer = new LogLayer({ transport: transports })
  if (options.context) layer.withContext(toJsonSafe(options.context))

  const emit =
    (level: LogLevel) =>
    (event: string, fields: Record<string, unknown> = {}) => {
      if (LEVEL_RANK[level] < threshold) return
      // Flatten bigints BEFORE loglayer so both the stderr line and the BetterStack payload serialize.
      layer.withMetadata(toJsonSafe(fields))[level](event)
    }

  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') }
}
