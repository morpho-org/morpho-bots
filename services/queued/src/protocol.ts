import type { Address, Hex } from 'viem'

import { isAddress, isHex } from 'viem'

export const MAX_TRANSACTION_LINE_BYTES = 262_144
export const QUEUE_SUCCESS_STATUSES = [
  'submitted',
  'would_submit',
  'deduped',
  'sim_reverted'
] as const
export const QUEUE_ERROR_CODES = [
  'bad_request',
  'chain_mismatch',
  'retry',
  'fatal',
  'internal'
] as const

export type QueueErrorCode = (typeof QUEUE_ERROR_CODES)[number]

export type QueuedTransaction = {
  kind: 'transaction'
  chainId: number
  id: string
  to: Address
  data: Hex
  value: string
  simulatedAtBlock?: number
}

export type QueueAck =
  | {
      ok: true
      id: string
      status: (typeof QUEUE_SUCCESS_STATUSES)[number]
      txHash?: Hex
      nonce?: number
      reason?: string
    }
  | {
      ok: false
      code: QueueErrorCode
      error: string
      id?: string
    }

export class TransactionError extends Error {
  constructor(
    readonly code: Extract<QueueErrorCode, 'bad_request' | 'chain_mismatch'>,
    message: string,
    readonly id?: string
  ) {
    super(message)
    this.name = 'TransactionError'
  }
}

function parseTransaction(value: unknown, chainId: number): QueuedTransaction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TransactionError('bad_request', 'transaction must be an object')
  }
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' && record.id ? record.id : undefined
  if (!id) throw new TransactionError('bad_request', 'transaction id must be a non-empty string')
  if (record.kind !== 'transaction') {
    throw new TransactionError('bad_request', "kind must be 'transaction'", id)
  }
  if (record.chainId !== chainId) {
    throw new TransactionError(
      'chain_mismatch',
      `transaction chain ${String(record.chainId)} != daemon chain ${chainId}`,
      id
    )
  }
  if (typeof record.to !== 'string' || !isAddress(record.to)) {
    throw new TransactionError('bad_request', 'transaction to must be an address', id)
  }
  if (typeof record.data !== 'string' || !isHex(record.data)) {
    throw new TransactionError('bad_request', 'transaction data must be hex', id)
  }
  if (typeof record.value !== 'string' || !/^\d+$/.test(record.value)) {
    throw new TransactionError('bad_request', 'transaction value must be a decimal string', id)
  }
  if (record.value !== '0') {
    throw new TransactionError('bad_request', 'transaction value must be zero', id)
  }
  if (
    record.simulatedAtBlock !== undefined &&
    (typeof record.simulatedAtBlock !== 'number' || !Number.isSafeInteger(record.simulatedAtBlock))
  ) {
    throw new TransactionError('bad_request', 'simulatedAtBlock must be a safe integer', id)
  }
  return {
    kind: 'transaction',
    chainId,
    id,
    to: record.to,
    data: record.data,
    value: record.value,
    ...(typeof record.simulatedAtBlock === 'number'
      ? { simulatedAtBlock: record.simulatedAtBlock }
      : {})
  }
}

export function parseTransactionLine(line: string, chainId: number): QueuedTransaction {
  try {
    return parseTransaction(JSON.parse(line), chainId)
  } catch (error) {
    if (error instanceof TransactionError) throw error
    throw new TransactionError('bad_request', 'transaction line is not valid JSON')
  }
}

export function serializeAck(ack: QueueAck): string {
  return `${JSON.stringify(ack)}\n`
}
