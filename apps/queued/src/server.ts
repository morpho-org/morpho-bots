import type { Logger } from '@repo/evm-kit'
import type { UnixJsonServer } from '@repo/ipc'

import { createUnixJsonServer } from '@repo/ipc'
import { ensureError } from '@repo/utils'

import type { Engine } from './engine'
import type { QueueAck, QueuedTransaction } from './protocol'

import { EngineError } from './engine'
import {
  MAX_TRANSACTION_LINE_BYTES,
  parseTransactionLine,
  serializeAck,
  TransactionError
} from './protocol'

type QueuedServer = UnixJsonServer

/**
 * Parse one JSONL request and hand it to the engine, returning the serialized ack. Parse and ingest
 * run in separate try-scopes so the ingest catch can attach the transaction's correlation `id` to
 * every error ack — a parse failure carries a best-effort `id` on {@link TransactionError}, and an
 * `EngineError` / unexpected throw is joined to the position via `transaction.id`. Exported so the
 * line-handling contract is unit-testable with a fake engine, no socket required.
 */
export async function handleQueuedLine(
  line: string,
  deps: { chainId: number; engine: Engine; log: Logger }
): Promise<string> {
  const { chainId, engine, log } = deps
  let transaction: QueuedTransaction
  try {
    transaction = parseTransactionLine(line, chainId)
  } catch (error) {
    if (error instanceof TransactionError) {
      return serializeAck({
        ok: false,
        code: error.code,
        error: error.message,
        ...(error.id ? { id: error.id } : {})
      })
    }
    // parseTransactionLine only ever throws TransactionError; this is a defensive fallback.
    log.error('queued.internal', { error: ensureError(error).message })
    return serializeAck({ ok: false, code: 'internal', error: 'internal queued error' })
  }
  try {
    return serializeAck(await engine.ingest(transaction))
  } catch (error) {
    if (error instanceof EngineError) {
      return serializeAck({
        ok: false,
        code: error.code,
        error: error.message,
        id: transaction.id
      })
    }
    log.error('queued.internal', { id: transaction.id, error: ensureError(error).message })
    return serializeAck({
      ok: false,
      code: 'internal',
      error: 'internal queued error',
      id: transaction.id
    })
  }
}

export function createQueuedServer(options: {
  socketPath: string
  chainId: number
  engine: Engine
  log: Logger
}): QueuedServer {
  const { socketPath, chainId, engine, log } = options

  const oversize: QueueAck = {
    ok: false,
    code: 'bad_request',
    error: 'transaction line too large'
  }
  return createUnixJsonServer({
    socketPath,
    maxLineBytes: MAX_TRANSACTION_LINE_BYTES,
    handleLine: line => handleQueuedLine(line, { chainId, engine, log }),
    oversizeResponse: () => serializeAck(oversize)
  })
}
