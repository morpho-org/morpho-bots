import type { Server, Socket } from 'node:net'
import type { LocalAccount } from 'viem'

import { assertNever } from '@repo/utils'
import { chmodSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { keccak256 } from 'viem'

import type { Policy } from './policy'

import { evaluatePolicy } from './policy'
import {
  errorResponse,
  fromWireTx,
  okResponse,
  parseRequestLine,
  ProtocolError,
  serializeResponse,
  toWireTx
} from './protocol'

/** The maximum bytes one request line may reach without a newline before the connection is killed. */
export const MAX_LINE_BYTES = 65536

/**
 * A structural logger: the CLI passes bot-kit's `createLogger` here without `@repo/signer` depending
 * on bot-kit. Every method must route to stderr (stdout stays the data plane).
 */
export type SignerLog = {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

/** The running daemon handle: bring it up, tear it down, and read the sole address it signs for. */
export type SignerServer = {
  listen(): Promise<void>
  close(): Promise<void>
  address: string
}

/**
 * Builds a policy-enforcing signing daemon over a Unix domain socket. The account is the only key
 * holder; every `signTransaction` request is validated by the codec, evaluated against `policy`
 * (default-deny), then signed offline. Connections stay open and speak newline-delimited JSON. The
 * daemon never logs the key or the full signed-tx hex — only tx fields and the keccak hash.
 */
export function createSignerServer(options: {
  socketPath: string
  account: LocalAccount
  policy: Policy
  log: SignerLog
}): SignerServer {
  const { socketPath, account, policy, log } = options
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
        case 'address':
          return serializeResponse(okResponse(id, { address: account.address }))
        case 'signTransaction': {
          const wire = toWireTx(request.params, id)
          const decision = evaluatePolicy(policy, wire)
          if (!decision.ok) {
            log.warn('signer.rejected', {
              rule: decision.rule,
              check: decision.check,
              chainId: wire.chainId,
              to: wire.to
            })
            return serializeResponse(
              errorResponse(id, 'policy_violation', decision.message, {
                rule: decision.rule,
                check: decision.check
              })
            )
          }
          const signedTransaction = await account.signTransaction(fromWireTx(wire))
          log.info('signer.signed', {
            rule: decision.rule,
            chainId: wire.chainId,
            to: wire.to,
            nonce: wire.nonce,
            gas: wire.gas,
            maxFeePerGas: wire.maxFeePerGas,
            hash: keccak256(signedTransaction)
          })
          return serializeResponse(okResponse(id, { signedTransaction }))
        }
        default:
          return assertNever(request.method)
      }
    } catch (error) {
      if (error instanceof ProtocolError) {
        return serializeResponse(errorResponse(error.id ?? id, error.code, error.message))
      }
      log.error('signer.internal', {
        error: error instanceof Error ? error.message : String(error)
      })
      return serializeResponse(errorResponse(id, 'internal', 'internal signer error'))
    }
  }

  function onConnection(socket: Socket): void {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    // ECONNRESET on client hangup is normal; swallow so a dropped client never crashes the daemon.
    socket.on('error', () => {})

    let buffer = ''
    // Serialize per-connection work so async signing keeps response order matching request order.
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
    address: account.address,

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
