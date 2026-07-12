import type { Socket } from 'node:net'

import { connect } from 'node:net'
import { isHex } from 'viem'

import type { QueueAck, QueuedTransaction } from './protocol'

import { QUEUE_ERROR_CODES, QUEUE_SUCCESS_STATUSES } from './protocol'

const CONNECT_TIMEOUT_MS = 5_000
const ACK_TIMEOUT_MS = 30_000

type QueuedClient = {
  send(transaction: QueuedTransaction): Promise<QueueAck>
  close(): void
}

const SUCCESS_STATUSES = new Set<string>(QUEUE_SUCCESS_STATUSES)
const ERROR_CODES = new Set<string>(QUEUE_ERROR_CODES)

function parseAck(line: string, expectedId: string): QueueAck {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error('queued returned non-JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('queued returned a malformed ack')
  }
  const ack = value as Record<string, unknown>
  if (ack.ok === true) {
    if (
      ack.id !== expectedId ||
      typeof ack.status !== 'string' ||
      !SUCCESS_STATUSES.has(ack.status) ||
      (ack.txHash !== undefined && (typeof ack.txHash !== 'string' || !isHex(ack.txHash))) ||
      (ack.nonce !== undefined &&
        (typeof ack.nonce !== 'number' || !Number.isSafeInteger(ack.nonce) || ack.nonce < 0)) ||
      (ack.reason !== undefined && typeof ack.reason !== 'string')
    ) {
      throw new Error('queued returned a malformed or mismatched success ack')
    }
    return ack as QueueAck
  }
  if (
    ack.ok !== false ||
    typeof ack.code !== 'string' ||
    !ERROR_CODES.has(ack.code) ||
    typeof ack.error !== 'string' ||
    (ack.id !== undefined && ack.id !== expectedId)
  ) {
    throw new Error('queued returned a malformed or mismatched error ack')
  }
  return ack as QueueAck
}

export function connectQueued(socketPath: string): Promise<QueuedClient> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath)
    let buffer = ''
    let opened = false
    let pending: {
      resolve: (ack: QueueAck) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
      id: string
    } | null = null
    const connectTimer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`queued connect timed out after ${CONNECT_TIMEOUT_MS}ms`))
    }, CONNECT_TIMEOUT_MS)

    const fail = (error: Error) => {
      if (!pending) return
      clearTimeout(pending.timer)
      const rejectPending = pending.reject
      pending = null
      rejectPending(error)
    }
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1 || !pending) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const current = pending
      pending = null
      clearTimeout(current.timer)
      try {
        current.resolve(parseAck(line, current.id))
      } catch (error) {
        current.reject(error as Error)
      }
    })
    socket.on('error', error => {
      clearTimeout(connectTimer)
      if (!opened) reject(error)
      else fail(error)
    })
    socket.on('close', () => {
      clearTimeout(connectTimer)
      fail(new Error('queued connection closed before an ack'))
    })
    socket.on('connect', () => {
      opened = true
      clearTimeout(connectTimer)
      resolve({
        send(transaction) {
          if (pending) return Promise.reject(new Error('queued client is busy'))
          return new Promise<QueueAck>((resolveAck, rejectAck) => {
            const timer = setTimeout(
              () => fail(new Error(`queued ack timed out after ${ACK_TIMEOUT_MS}ms`)),
              ACK_TIMEOUT_MS
            )
            pending = { resolve: resolveAck, reject: rejectAck, timer, id: transaction.id }
            socket.write(`${JSON.stringify(transaction)}\n`)
          })
        },
        close: () => socket.destroy()
      })
    })
  })
}
