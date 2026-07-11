import type { Logger } from '@repo/bot-kit'
import type { Server, Socket } from 'node:net'

import {
  errorResponse,
  ingestRecord,
  MAX_LINE_BYTES,
  okResponse,
  parseRequestLine,
  QueuedProtocolError,
  serializeResponse
} from '@repo/bot-kit'
import { assertNever, ensureError } from '@repo/utils'
import { chmodSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'

import type { Engine } from './engine'

import { EngineError } from './engine'

/** The running daemon socket handle: bring it up, tear it down. */
export type QueuedServer = {
  listen(): Promise<void>
  close(): Promise<void>
}

/**
 * Builds the queue daemon's Unix-domain-socket server around an {@link Engine}. Connections stay open
 * and speak newline-delimited JSON; per-connection work is serialized so async ingests keep response
 * order matching request order (the engine's own mutex serializes ACROSS connections). Framing,
 * oversize handling, and 0600 socket hygiene are cloned from `@repo/signer`'s server. The server owns
 * only the socket — the engine owns state, timers, and shutdown (main.ts sequences the two).
 */
export function createQueuedServer(options: {
  socketPath: string
  engine: Engine
  log: Logger
}): QueuedServer {
  const { socketPath, engine, log } = options
  const sockets = new Set<Socket>()
  let closed = false

  async function handleLine(line: string): Promise<string> {
    let id = ''
    try {
      const request = parseRequestLine(line)
      id = request.id
      switch (request.method) {
        case 'ping':
          return serializeResponse(okResponse(id, { pong: true }))
        case 'status':
          return serializeResponse(okResponse(id, engine.status()))
        case 'ingest': {
          const record = ingestRecord(request.params, id)
          const result = await engine.ingest(record)
          return serializeResponse(okResponse(id, result))
        }
        default:
          return assertNever(request.method)
      }
    } catch (error) {
      if (error instanceof QueuedProtocolError) {
        return serializeResponse(errorResponse(error.id ?? id, error.code, error.message))
      }
      if (error instanceof EngineError) {
        // Per-record errors are request-scoped: the connection survives, the client warns+skips or
        // (retry) exits 1. Nothing here kills the connection except an oversize line (below).
        return serializeResponse(errorResponse(id, error.code, error.message))
      }
      log.error('queued.internal', { error: ensureError(error).message })
      return serializeResponse(errorResponse(id, 'internal', 'internal queued error'))
    }
  }

  function onConnection(socket: Socket): void {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    // ECONNRESET on client hangup is normal; swallow so a dropped client never crashes the daemon.
    socket.on('error', () => {})

    let buffer = ''
    // Serialize per-connection so a client's pipelined ingests keep response order = request order.
    let queue: Promise<void> = Promise.resolve()

    const oversize = (): boolean =>
      buffer.indexOf('\n') === -1 && Buffer.byteLength(buffer) > MAX_LINE_BYTES

    socket.on('data', chunk => {
      queue = queue.then(async () => {
        buffer += chunk.toString('utf8')
        if (oversize()) {
          socket.write(
            serializeResponse(errorResponse('', 'bad_request', 'request line too large'))
          )
          buffer = ''
          socket.destroy()
          return
        }
        let idx = buffer.indexOf('\n')
        while (idx !== -1) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.trim() !== '') socket.write(await handleLine(line))
          idx = buffer.indexOf('\n')
        }
        if (oversize()) {
          socket.write(
            serializeResponse(errorResponse('', 'bad_request', 'request line too large'))
          )
          buffer = ''
          socket.destroy()
        }
      })
    })
  }

  const server: Server = createServer(onConnection)

  return {
    listen() {
      return new Promise<void>((resolve, reject) => {
        // Socket is born 0600 (0o666 & ~0o177) so there is no world-readable window before chmod.
        const prevUmask = process.umask(0o177)
        const onError = (error: Error) => {
          process.umask(prevUmask)
          reject(error)
        }
        server.once('error', onError)
        server.listen(socketPath, () => {
          server.removeListener('error', onError)
          process.umask(prevUmask)
          // Belt-and-braces: re-assert 0600 in case the platform ignores umask for sockets.
          chmodSync(socketPath, 0o600)
          resolve()
        })
      })
    },

    close() {
      if (closed) return Promise.resolve()
      closed = true
      for (const socket of sockets) socket.destroy()
      return new Promise<void>(resolve => {
        server.close(() => {
          try {
            unlinkSync(socketPath)
          } catch {
            // Already gone (never listened, or unlinked elsewhere) — close is idempotent.
          }
          resolve()
        })
      })
    }
  }
}
