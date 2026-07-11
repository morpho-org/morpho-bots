import type { LogLevel, OutcomeRecord, TxRecord } from '@repo/bot-kit'
import type { BotName } from '@repo/home'

import {
  createLogger,
  MAX_LINE_BYTES,
  QUEUED_PROTOCOL_VERSION,
  QueuedProtocolError
} from '@repo/bot-kit'
import {
  assertSunPathLength,
  botsHome,
  ConfigError,
  warnOnLooseSecrets,
  queuedSocketFile
} from '@repo/home'
import { ensureError } from '@repo/utils'

import type { QueuedClient } from '../queued-client'

import { mergedEnv } from '../config'
import {
  connectQueued,
  QUEUED_HANDSHAKE_TIMEOUT_MS,
  QUEUED_INGEST_TIMEOUT_MS
} from '../queued-client'
import { collectQueueRecords } from '../wire-input'
import { emitLine, fail } from './shared'

type Env = Record<string, string | undefined>

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// The thin client never validates config beyond chain resolution, so a bad LOG_LEVEL is not worth an
// exit 2 here (the daemon owns the strict validation). Fall back to `info` rather than throwing.
function resolveLogLevel(env: Env): LogLevel {
  const level = env.LOG_LEVEL?.trim()
  return LOG_LEVELS.find(candidate => candidate === level) ?? 'info'
}

/**
 * `<domain> queue`: a thin relay into the per-chain `queued` daemon. It holds NO key, NO queue state,
 * and NO signer — the daemon owns all of that. TTY stdin (a human health-checking the daemon) → a
 * `ping`. Otherwise it drains stdin, pre-filters records to this domain+chain, opens ONE socket
 * connection, runs a `status` handshake, then relays each record as an `ingest` and echoes the
 * daemon's ack `OutcomeRecord` to stdout. Terminal fates (`confirmed`/`reverted`/`dropped`) no longer
 * ride the pipe — they land in the daemon's `outcomes.jsonl`.
 *
 * Exit codes: 0 on a complete handoff (per-record `bad_request`/`unsupported_version`/`chain_mismatch`
 * are warn+skip, still 0 — the wire discipline that a malformed line never kills a stage); 1 on a
 * transport failure, timeout, or a `retry`/`internal` daemon error (transient — the loop retries); 2
 * on a handshake failure (daemon chain mismatch, protocol-version mismatch) or a ConfigError
 * (unresolved chain, oversize socket path, stdin wire-version skew).
 */
export async function runQueueCommand(
  domain: BotName,
  opts: { chain?: string | undefined }
): Promise<number> {
  const home = botsHome()

  let env: Env
  let chainId: string
  let socketPath: string
  try {
    warnOnLooseSecrets(home)
    ;({ env, chainId } = mergedEnv({ home, bot: domain, chain: opts.chain }))
    // The chain id flows into `Number(chainId)` below (the daemon-handshake comparison); reject a
    // non-numeric value loud (exit 2) here rather than silently comparing against `NaN`.
    if (!/^\d+$/.test(chainId)) {
      throw new ConfigError(
        `resolved chain id '${chainId}' is not a positive integer — check --chain / CHAIN_ID and config`
      )
    }
    socketPath = env.QUEUED_SOCKET?.trim() || queuedSocketFile(home, chainId)
    assertSunPathLength(socketPath)
  } catch (error) {
    fail('startup.error', error)
    return 2
  }

  const logger = createLogger(resolveLogLevel(env))
  // The client reads no key at all now; the queued daemon is the sole local-key reader (when
  // SIGNER_SOCKET is unset). A LIQUIDATOR_PRIVATE_KEY riding the bot section is dead weight here.
  if (env.LIQUIDATOR_PRIVATE_KEY) {
    logger.warn('queue.key_ignored', {
      bot: domain,
      chainId,
      detail:
        'the queue is now a thin client and reads no key — the queued daemon owns the signing key; ' +
        'move LIQUIDATOR_PRIVATE_KEY into the queued section'
    })
  }

  const chainIdNum = Number(chainId)

  // TTY stdin (no upstream pipe): a human health-check. Ping the daemon and map pong → 0, dead → 1.
  if (process.stdin.isTTY) {
    let client: QueuedClient
    try {
      client = await connectQueued(socketPath, QUEUED_HANDSHAKE_TIMEOUT_MS)
    } catch (error) {
      logger.error('queue.ping_failed', { chainId, detail: ensureError(error).message })
      return 1
    }
    try {
      const result = await client.request('ping', undefined, QUEUED_HANDSHAKE_TIMEOUT_MS)
      const alive = (result as { pong?: unknown }).pong === true
      if (!alive) logger.error('queue.ping_failed', { chainId, detail: 'daemon did not pong' })
      return alive ? 0 : 1
    } catch (error) {
      logger.error('queue.ping_failed', { chainId, detail: ensureError(error).message })
      return 1
    } finally {
      client.close()
    }
  }

  // Drain stdin to EOF FIRST (so an upstream `liquidate` finishes cleanly even if the daemon is down),
  // then parse. A record from a newer wire version stops the pass (exit 2) — deploy skew, not data.
  const collected = collectQueueRecords(await Bun.stdin.text(), logger)
  if (collected.versionSkew) {
    fail('wire.version_skew', new Error('input record has a newer wire version than this build'))
    return 2
  }

  // Outcomes drive backoff, txs submit — the daemon treats each ingest independently, so mirror the
  // pre-daemon one-shot ordering (outcomes' backoff bookkeeping, then submits). Foreign domain/chain
  // records are warn+skipped here (the client pre-filters; the daemon re-checks as defense-in-depth).
  const records: (TxRecord | OutcomeRecord)[] = [...collected.outcomes, ...collected.txs]

  let client: QueuedClient
  try {
    client = await connectQueued(socketPath, QUEUED_HANDSHAKE_TIMEOUT_MS)
  } catch (error) {
    logger.error('queue.connect_failed', { chainId, detail: ensureError(error).message })
    return 1
  }

  try {
    // Handshake: confirm the daemon serves THIS chain and speaks THIS protocol before relaying work.
    try {
      const status = await client.request('status', undefined, QUEUED_HANDSHAKE_TIMEOUT_MS)
      // A status reply without a numeric chainId is an unusable daemon — treat it like a chain
      // mismatch (handshake failure, exit 2) rather than reading through to `NaN`.
      if (!isRecord(status) || typeof status.chainId !== 'number') {
        fail('queue.handshake_failed', new Error('daemon status did not report a numeric chainId'))
        return 2
      }
      if (status.chainId !== chainIdNum) {
        fail(
          'queue.handshake_failed',
          new Error(`daemon serves chain ${status.chainId}, not ${chainIdNum}`)
        )
        return 2
      }
    } catch (error) {
      // A protocol-version mismatch is a handshake failure (exit 2); any other status failure is
      // transient (a dead/slow daemon → exit 1, the loop retries).
      if (error instanceof QueuedProtocolError && error.code === 'unsupported_version') {
        fail('queue.handshake_failed', error)
        return 2
      }
      logger.error('queue.handshake_failed', { chainId, detail: ensureError(error).message })
      return 1
    }

    for (const record of records) {
      if (record.domain !== domain || record.chainId !== chainIdNum) {
        logger.warn('queue.skip', {
          reason: 'unaccepted',
          domain: record.domain,
          recordChainId: record.chainId
        })
        continue
      }
      // Client-side oversize guard: the daemon KILLS the connection when a single request line
      // reaches MAX_LINE_BYTES without a newline, which would starve every later record in the
      // batch. Pre-check the line this record would produce (mirroring the envelope
      // `queued-client` writes, a fixed-length uuid standing in for the real id) and warn+skip an
      // oversize record — exit stays 0, the rest of the batch still flows.
      const requestBytes = Buffer.byteLength(
        `${JSON.stringify({
          v: QUEUED_PROTOCOL_VERSION,
          id: '00000000-0000-0000-0000-000000000000',
          method: 'ingest',
          params: { record }
        })}\n`
      )
      if (requestBytes > MAX_LINE_BYTES) {
        logger.warn('queue.skip', {
          reason: 'oversize',
          id: record.id,
          detail: `serialized request is ${requestBytes} bytes; the daemon caps a line at ${MAX_LINE_BYTES}`
        })
        continue
      }
      try {
        const result = await client.request('ingest', { record }, QUEUED_INGEST_TIMEOUT_MS)
        // Structural guard before echoing: only a well-formed outcome record rides the pipe. A
        // malformed ack is warn+skipped (exit stays 0) rather than emitted or read through blindly.
        const outcome = isRecord(result) ? result.outcome : undefined
        if (isRecord(outcome) && outcome.kind === 'outcome') {
          emitLine(outcome as unknown as OutcomeRecord)
        } else {
          logger.warn('queue.skip', {
            reason: 'malformed_ack',
            id: record.id,
            detail: 'daemon ingest ack was not a well-formed outcome record'
          })
        }
      } catch (error) {
        if (error instanceof QueuedProtocolError) {
          // Per-record defense-in-depth: a malformed/foreign/skewed record is warn+skipped, the batch
          // survives (still exit 0). A `retry`/`internal` is transient — break the batch and exit 1
          // (mirrors the one-shot's break-the-batch; subsequent submits would NACK the same way).
          if (
            error.code === 'bad_request' ||
            error.code === 'unsupported_version' ||
            error.code === 'chain_mismatch'
          ) {
            logger.warn('queue.skip', { reason: error.code, id: record.id, detail: error.message })
            continue
          }
          logger.error('queue.ingest_failed', {
            code: error.code,
            id: record.id,
            detail: error.message
          })
          return 1
        }
        // A transport failure (timeout, socket closed) is transient — the connection is likely dead,
        // so break the batch and let the loop retry.
        logger.error('queue.ingest_failed', { id: record.id, detail: ensureError(error).message })
        return 1
      }
    }
    return 0
  } finally {
    client.close()
  }
}
