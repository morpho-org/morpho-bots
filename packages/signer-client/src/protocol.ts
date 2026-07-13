import type { Address, Hex, TransactionSerializableEIP1559 } from 'viem'

import { getAddress, isAddress, isHex } from 'viem'

export const SIGNER_PROTOCOL_VERSION = 3

export type SignerRequest =
  | { v: number; method: 'address' }
  | { v: number; method: 'signTransaction'; transaction: unknown }

export const SIGNER_ERROR_CODES = [
  'bad_request',
  'unsupported_version',
  'policy_violation',
  'internal'
] as const

export type SignerErrorCode = (typeof SIGNER_ERROR_CODES)[number]

export type SignerErrorBody = {
  code: SignerErrorCode
  message: string
  check?: string
}

export type SignerResponse =
  | { v: number; ok: true; result: unknown }
  | { v: number; ok: false; error: SignerErrorBody }

export type WireTx = {
  type: 'eip1559'
  chainId: number
  to: Address
  data: Hex
  value: string
  nonce: number
  gas: string
  maxFeePerGas: string
  maxPriorityFeePerGas: string
}

export class ProtocolError extends Error {
  constructor(
    readonly code: SignerErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}

const DECIMAL = /^\d+$/

function field(record: Record<string, unknown>, key: string): unknown {
  const value = record[key]
  if (value === undefined || value === null) {
    throw new ProtocolError('bad_request', `missing required field '${key}'`)
  }
  return value
}

function decimalField(record: Record<string, unknown>, key: string): string {
  const value = field(record, key)
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new ProtocolError('bad_request', `field '${key}' must be a decimal string`)
  }
  return value
}

function integerField(record: Record<string, unknown>, key: string): number {
  const value = field(record, key)
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ProtocolError('bad_request', `field '${key}' must be a non-negative integer`)
  }
  return value
}

/** Strictly narrows an untrusted signing payload to a complete EIP-1559 transaction. */
export function toWireTx(raw: unknown): WireTx {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProtocolError('bad_request', 'transaction must be an object')
  }
  const record: Record<string, unknown> = { ...raw }
  if (field(record, 'type') !== 'eip1559') {
    throw new ProtocolError('bad_request', `unsupported tx type '${String(record.type)}'`)
  }
  const chainId = integerField(record, 'chainId')
  if (chainId === 0) throw new ProtocolError('bad_request', 'chainId must be non-zero')
  const to = field(record, 'to')
  if (typeof to !== 'string' || !isAddress(to, { strict: false })) {
    throw new ProtocolError('bad_request', "field 'to' must be a valid address")
  }
  const data = field(record, 'data')
  if (typeof data !== 'string' || !isHex(data)) {
    throw new ProtocolError('bad_request', "field 'data' must be hex")
  }
  const gas = decimalField(record, 'gas')
  if (BigInt(gas) === 0n) throw new ProtocolError('bad_request', 'gas must be greater than 0')
  const maxFeePerGas = decimalField(record, 'maxFeePerGas')
  const maxPriorityFeePerGas = decimalField(record, 'maxPriorityFeePerGas')
  if (BigInt(maxPriorityFeePerGas) > BigInt(maxFeePerGas)) {
    throw new ProtocolError('bad_request', 'maxPriorityFeePerGas cannot exceed maxFeePerGas')
  }
  return {
    type: 'eip1559',
    chainId,
    to: getAddress(to),
    data,
    value: decimalField(record, 'value'),
    nonce: integerField(record, 'nonce'),
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas
  }
}

export function parseRequestLine(line: string): SignerRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new ProtocolError('bad_request', 'request line is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError('bad_request', 'request must be a JSON object')
  }
  const record: Record<string, unknown> = { ...parsed }
  if (record.v !== SIGNER_PROTOCOL_VERSION) {
    if (typeof record.v !== 'number') {
      throw new ProtocolError('bad_request', "field 'v' must be a number")
    }
    throw new ProtocolError('unsupported_version', `unsupported protocol version ${record.v}`)
  }
  if (record.method === 'address') return { v: record.v, method: 'address' }
  if (record.method === 'signTransaction') {
    return { v: record.v, method: 'signTransaction', transaction: field(record, 'transaction') }
  }
  throw new ProtocolError('bad_request', `unknown method '${String(record.method)}'`)
}

export function fromWireTx(tx: WireTx): TransactionSerializableEIP1559 {
  return {
    ...tx,
    value: BigInt(tx.value),
    gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas)
  }
}

export function serializeResponse(response: SignerResponse): string {
  return `${JSON.stringify(response)}\n`
}

export function okResponse(result: unknown): SignerResponse {
  return { v: SIGNER_PROTOCOL_VERSION, ok: true, result }
}

export function errorResponse(
  code: SignerErrorCode,
  message: string,
  extra?: { check?: string }
): SignerResponse {
  return { v: SIGNER_PROTOCOL_VERSION, ok: false, error: { code, message, ...extra } }
}
