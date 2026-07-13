import type { Logger } from '@repo/evm-kit'
import type { UnixJsonServer } from '@repo/ipc'

import { createUnixJsonServer } from '@repo/ipc'
import { ensureError } from '@repo/utils'

import type { Engine } from './engine'
import type { QueueAck } from './protocol'

import { EngineError } from './engine'
import {
  MAX_TRANSACTION_LINE_BYTES,
  parseTransactionLine,
  serializeAck,
  TransactionError
} from './protocol'

type QueuedServer = UnixJsonServer

export function createQueuedServer(options: {
  socketPath: string
  chainId: number
  engine: Engine
  log: Logger
}): QueuedServer {
  const { socketPath, chainId, engine, log } = options

  async function handleLine(line: string): Promise<string> {
    try {
      return serializeAck(await engine.ingest(parseTransactionLine(line, chainId)))
    } catch (error) {
      if (error instanceof TransactionError) {
        return serializeAck({
          ok: false,
          code: error.code,
          error: error.message,
          ...(error.id ? { id: error.id } : {})
        })
      }
      if (error instanceof EngineError) {
        return serializeAck({ ok: false, code: error.code, error: error.message })
      }
      log.error('queued.internal', { error: ensureError(error).message })
      return serializeAck({ ok: false, code: 'internal', error: 'internal queued error' })
    }
  }

  const oversize: QueueAck = {
    ok: false,
    code: 'bad_request',
    error: 'transaction line too large'
  }
  return createUnixJsonServer({
    socketPath,
    maxLineBytes: MAX_TRANSACTION_LINE_BYTES,
    handleLine,
    oversizeResponse: () => serializeAck(oversize)
  })
}
