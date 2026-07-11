import type { QueuedMethod, QueuedResponse } from '@repo/bot-kit'
import type { Socket } from 'node:net'

import { isQueuedResponse, QUEUED_PROTOCOL_VERSION, QueuedProtocolError } from '@repo/bot-kit'
import { connect } from 'node:net'

/** Handshake reads (`ping`/`status`) are cheap round-trips; a short cap surfaces a dead daemon fast. */
export const QUEUED_HANDSHAKE_TIMEOUT_MS = 5_000
/** An `ingest` spans dedupe → re-sim → fee → broadcast on the daemon, so it gets a generous budget. */
export const QUEUED_INGEST_TIMEOUT_MS = 30_000

/**
 * The CLI's thin transport to the `queued` daemon — pure `node:net` against the shared
 * `@repo/bot-kit` protocol module (no import from `services/queued`). ONE connection carries the whole
 * batch (`status` handshake + N `ingest`s): the daemon serializes per connection and answers in
 * request order, so a single reused socket is both correct and cheaper than the signer client's
 * connection-per-request. Requests are issued sequentially (one in flight at a time), which the
 * pipeline's stdin-order ingest already is.
 *
 * A protocol-level error RESPONSE surfaces as a typed {@link QueuedProtocolError} (carrying the wire
 * `code` so the caller can warn+skip vs exit); a transport failure — connect refused, timeout, socket
 * closed mid-request, or a malformed line — surfaces as a plain {@link Error}. A response whose
 * envelope `v` disagrees with ours is a daemon-protocol mismatch, reported as a typed
 * `unsupported_version` so the caller maps it to a handshake failure (exit 2) rather than a transient.
 */
export type QueuedClient = {
  /** Sends one request and resolves the unwrapped `result`, or rejects (typed protocol / plain transport). */
  request(method: QueuedMethod, params: unknown, timeoutMs: number): Promise<unknown>
  /** Tears the connection down; idempotent. */
  close(): void
}

function unwrap(response: QueuedResponse): unknown {
  if ('error' in response) {
    throw new QueuedProtocolError(response.error.code, response.error.message, response.id)
  }
  return response.result
}

/**
 * Opens the connection and resolves a {@link QueuedClient} once the socket is up. Rejects with a plain
 * error if the connect fails or times out (a dead/absent daemon → the caller exits 1, the loop
 * retries).
 */
export function connectQueued(
  socketPath: string,
  connectTimeoutMs = QUEUED_HANDSHAKE_TIMEOUT_MS
): Promise<QueuedClient> {
  return new Promise<QueuedClient>((resolve, reject) => {
    const socket: Socket = connect(socketPath)
    let opened = false
    let buffer = ''
    // At most one request is in flight (requests are issued sequentially), so a single slot suffices.
    // `id` is the id we sent, so a stray/out-of-order response line can be matched (and dropped if it
    // is addressed to some other request) instead of being handed to the wrong caller.
    let pending: {
      id: string
      resolve: (response: QueuedResponse) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    } | null = null

    const connectTimer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`queued connect timed out after ${connectTimeoutMs}ms`))
    }, connectTimeoutMs)

    const failPending = (error: Error): void => {
      if (!pending) return
      const p = pending
      pending = null
      clearTimeout(p.timer)
      p.reject(error)
    }

    const deliver = (line: string): void => {
      if (!pending) return
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        const p = pending
        pending = null
        clearTimeout(p.timer)
        p.reject(new Error('queued returned a non-JSON response line'))
        return
      }
      // Response-id guard: the daemon answers in request order over one connection, but a stray or
      // out-of-order line whose id is NOT the one we sent must never be delivered to this caller —
      // drop it and keep waiting for the matching reply (the request timeout still bounds the wait).
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { id?: unknown }).id === 'string' &&
        (parsed as { id: string }).id !== pending.id
      ) {
        return
      }
      const p = pending
      pending = null
      clearTimeout(p.timer)
      // Envelope-version guard BEFORE the structural narrow: a daemon speaking a different protocol is
      // a handshake-level mismatch (the caller maps it to exit 2), distinct from a malformed line
      // (transport, exit 1). `isQueuedResponse` would also reject it, but as an untyped malformed line.
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { v?: unknown }).v === 'number' &&
        (parsed as { v: number }).v !== QUEUED_PROTOCOL_VERSION
      ) {
        p.reject(
          new QueuedProtocolError(
            'unsupported_version',
            `daemon protocol version ${(parsed as { v: number }).v} != ${QUEUED_PROTOCOL_VERSION}`
          )
        )
        return
      }
      if (!isQueuedResponse(parsed)) {
        p.reject(new Error('malformed queued response envelope'))
        return
      }
      p.resolve(parsed)
    }

    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.trim() !== '') deliver(line)
        idx = buffer.indexOf('\n')
      }
    })
    socket.on('error', error => {
      clearTimeout(connectTimer)
      if (!opened) {
        reject(error)
        return
      }
      failPending(error)
    })
    socket.on('close', () => {
      clearTimeout(connectTimer)
      failPending(new Error('queued connection closed before a response'))
    })
    socket.on('connect', () => {
      opened = true
      clearTimeout(connectTimer)
      resolve({
        request(method, params, timeoutMs) {
          return new Promise<QueuedResponse>((res, rej) => {
            if (pending) {
              rej(new Error('queued client is busy (a request is already in flight)'))
              return
            }
            const timer = setTimeout(
              () => failPending(new Error(`queued ${method} timed out after ${timeoutMs}ms`)),
              timeoutMs
            )
            const id = crypto.randomUUID()
            pending = { id, resolve: res, reject: rej, timer }
            const request = { v: QUEUED_PROTOCOL_VERSION, id, method, params }
            socket.write(`${JSON.stringify(request)}\n`)
          }).then(unwrap)
        },
        close() {
          socket.destroy()
        }
      })
    })
  })
}
