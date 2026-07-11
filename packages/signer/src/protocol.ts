import type { Address, Hex, TransactionSerializableEIP1559 } from 'viem'

import { getAddress, isAddress, isHex } from 'viem'

/**
 * The signing agent's wire contract: one JSON request line in, one JSON response line out over a
 * Unix domain socket. Bigint amounts ride as bare decimal strings (the `records.ts` convention),
 * `chainId`/`nonce` stay JSON numbers. A reader that sees an unknown `v` rejects the request.
 */
export const SIGNER_PROTOCOL_VERSION = 1

/** The three verbs the agent understands. `ping`/`address` are the client handshake; sign is the work. */
export type SignerMethod = 'ping' | 'address' | 'signTransaction'

/** A single request line: versioned envelope + opaque `params` (a {@link WireTx} for `signTransaction`). */
export type SignerRequest = {
  v: number
  id: string
  method: SignerMethod
  params?: unknown
}

/** The error taxonomy the agent reports; the client maps `policy_violation` to a distinguishable type. */
export type SignerErrorCode =
  | 'bad_request'
  | 'unsupported_version'
  | 'policy_violation'
  | 'internal'

/** The structured error body carried on a failure response. `rule`/`check` are set for policy rejections. */
export type SignerErrorBody = {
  code: SignerErrorCode
  message: string
  rule?: string
  check?: string
}

/** One response line: either a `result` payload or a structured `error`. */
export type SignerResponse =
  | { v: number; id: string; result: unknown }
  | { v: number; id: string; error: SignerErrorBody }

/**
 * A fully-specified EIP-1559 transaction to sign. Bigint fields (`value`/`gas`/fees) are bare
 * decimal strings; `to` is mandatory (the agent refuses contract deployments). viem silently signs
 * gas-less txs, so the codec hard-requires every field and `gas > 0`.
 */
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

/** A typed codec failure carrying the wire error `code` and (when known) the request `id` to echo. */
export class ProtocolError extends Error {
  readonly code: SignerErrorCode
  readonly id: string | undefined

  constructor(code: SignerErrorCode, message: string, id?: string) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.id = id
  }
}

const DECIMAL = /^\d+$/

function requireField(record: Record<string, unknown>, key: string, id: string): unknown {
  if (!(key in record) || record[key] === undefined || record[key] === null) {
    throw new ProtocolError('bad_request', `missing required field '${key}'`, id)
  }
  return record[key]
}

function decimalField(record: Record<string, unknown>, key: string, id: string): string {
  const value = requireField(record, key, id)
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new ProtocolError('bad_request', `field '${key}' must be a decimal string`, id)
  }
  return value
}

function integerField(record: Record<string, unknown>, key: string, id: string): number {
  const value = requireField(record, key, id)
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ProtocolError('bad_request', `field '${key}' must be a non-negative integer`, id)
  }
  return value
}

/**
 * Validates and normalizes an untrusted `signTransaction` params object into a {@link WireTx}. Every
 * field is required, bigint fields must be decimal strings, `to` must be a valid address, `data`
 * must be hex, and `gas` must be strictly positive (viem would otherwise sign a gas-less tx). Unknown
 * extra fields are tolerated. Throws {@link ProtocolError} (`bad_request`) on any violation.
 */
export function toWireTx(raw: unknown, id = ''): WireTx {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProtocolError('bad_request', 'signTransaction params must be an object', id)
  }
  const record: Record<string, unknown> = { ...raw }

  const type = requireField(record, 'type', id)
  if (type !== 'eip1559') {
    throw new ProtocolError('bad_request', `unsupported tx type '${String(type)}'`, id)
  }

  const chainId = integerField(record, 'chainId', id)
  if (chainId === 0) throw new ProtocolError('bad_request', 'chainId must be non-zero', id)

  const toRaw = requireField(record, 'to', id)
  if (typeof toRaw !== 'string' || !isAddress(toRaw, { strict: false })) {
    throw new ProtocolError('bad_request', "field 'to' must be a valid address", id)
  }

  const dataRaw = requireField(record, 'data', id)
  if (typeof dataRaw !== 'string' || !isHex(dataRaw)) {
    throw new ProtocolError('bad_request', "field 'data' must be hex", id)
  }

  const gas = decimalField(record, 'gas', id)
  if (BigInt(gas) <= 0n) throw new ProtocolError('bad_request', 'gas must be greater than 0', id)

  return {
    type: 'eip1559',
    chainId,
    to: getAddress(toRaw),
    data: dataRaw,
    value: decimalField(record, 'value', id),
    nonce: integerField(record, 'nonce', id),
    gas,
    maxFeePerGas: decimalField(record, 'maxFeePerGas', id),
    maxPriorityFeePerGas: decimalField(record, 'maxPriorityFeePerGas', id)
  }
}

/** Parses one request line into a {@link SignerRequest}. Throws {@link ProtocolError} on malformed input. */
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
  const id = typeof record.id === 'string' ? record.id : ''

  if (typeof record.v !== 'number') {
    throw new ProtocolError('bad_request', "field 'v' must be a number", id)
  }
  if (record.v !== SIGNER_PROTOCOL_VERSION) {
    throw new ProtocolError('unsupported_version', `unsupported protocol version ${record.v}`, id)
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new ProtocolError('bad_request', "field 'id' must be a non-empty string", id)
  }
  if (
    record.method !== 'ping' &&
    record.method !== 'address' &&
    record.method !== 'signTransaction'
  ) {
    throw new ProtocolError('bad_request', `unknown method '${String(record.method)}'`, id)
  }
  return { v: record.v, id: record.id, method: record.method, params: record.params }
}

/** Converts a validated {@link WireTx} into the viem transaction shape `account.signTransaction` accepts. */
export function fromWireTx(tx: WireTx): TransactionSerializableEIP1559 {
  return {
    type: 'eip1559',
    chainId: tx.chainId,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value),
    nonce: tx.nonce,
    gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas)
  }
}

/** Serializes a response to a single newline-terminated line ready to write to the socket. */
export function serializeResponse(response: SignerResponse): string {
  return `${JSON.stringify(response)}\n`
}

/** Builds a success response envelope. */
export function okResponse(id: string, result: unknown): SignerResponse {
  return { v: SIGNER_PROTOCOL_VERSION, id, result }
}

/** Builds an error response envelope. */
export function errorResponse(
  id: string,
  code: SignerErrorCode,
  message: string,
  extra?: { rule?: string; check?: string }
): SignerResponse {
  return { v: SIGNER_PROTOCOL_VERSION, id, error: { code, message, ...extra } }
}
