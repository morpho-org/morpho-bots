/**
 * The per-chain queue daemon's wire contract: one JSON request line in, one JSON response line out
 * over a Unix domain socket. This module is PURE DATA — envelope types, the protocol version, error
 * codes, and line codecs — with no sockets, so both sides standardize on it: the daemon
 * (`@repo/queued`) implements its server against it, and the CLI (`@repo/cli`) implements its own thin
 * `node:net` client against it. Framing/validation mirror `@repo/signer`'s hand-rolled
 * `protocol.ts` (no zod); the shapes live beside `records.ts`, which owns the wire-record contract
 * that rides inside `ingest` params.
 *
 * Two versions coexist on the wire: the protocol envelope `v` (this module) and the record `v`
 * (`records.ts`, {@link WIRE_VERSION}). A reader that sees an unknown protocol `v` rejects the
 * request; record-version skew is handled in-band as an `unsupported_version` error, not a framing
 * failure.
 */

/** Current protocol-envelope version. A reader that sees an unknown `v` rejects the request. */
export const QUEUED_PROTOCOL_VERSION = 1

/**
 * The maximum bytes one request line may reach without a newline before the connection is killed.
 * Larger than the signer's cap because a `tx` record (calldata) is bigger than a bare sign request.
 */
export const MAX_LINE_BYTES = 262_144

/** The three verbs the daemon understands. `ping`/`status` are the client handshake; `ingest` is the work. */
export type QueuedMethod = 'ping' | 'status' | 'ingest'

/** A single request line: versioned envelope + opaque `params` (`{ record }` for `ingest`). */
export type QueuedRequest = {
  v: number
  id: string
  method: QueuedMethod
  params?: unknown
}

/**
 * The error taxonomy the daemon reports. `bad_request`/`unsupported_version`/`chain_mismatch` are
 * per-record defense-in-depth (the client pre-filters, so these are warn+skip and never kill the
 * connection); `retry` marks a transient failure the client maps to exit 1 (`send_aborted`,
 * `submit_failed`, `base_fee_unavailable` ride in the message); `internal` is an unexpected fault.
 */
export type QueuedErrorCode =
  | 'bad_request'
  | 'unsupported_version'
  | 'chain_mismatch'
  | 'retry'
  | 'internal'

/** The structured error body carried on a failure response. */
export type QueuedErrorBody = {
  code: QueuedErrorCode
  message: string
}

/** One response line: either a `result` payload or a structured `error`. */
export type QueuedResponse =
  | { v: number; id: string; result: unknown }
  | { v: number; id: string; error: QueuedErrorBody }

/** A typed codec failure carrying the wire error `code` and (when known) the request `id` to echo. */
export class QueuedProtocolError extends Error {
  readonly code: QueuedErrorCode
  readonly id: string | undefined

  constructor(code: QueuedErrorCode, message: string, id?: string) {
    super(message)
    this.name = 'QueuedProtocolError'
    this.code = code
    this.id = id
  }
}

const QUEUED_METHODS: readonly QueuedMethod[] = ['ping', 'status', 'ingest']

/** Parses one request line into a {@link QueuedRequest}. Throws {@link QueuedProtocolError} on malformed input. */
export function parseRequestLine(line: string): QueuedRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new QueuedProtocolError('bad_request', 'request line is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new QueuedProtocolError('bad_request', 'request must be a JSON object')
  }
  const record: Record<string, unknown> = { ...parsed }
  const id = typeof record.id === 'string' ? record.id : ''

  if (typeof record.v !== 'number') {
    throw new QueuedProtocolError('bad_request', "field 'v' must be a number", id)
  }
  if (record.v !== QUEUED_PROTOCOL_VERSION) {
    throw new QueuedProtocolError(
      'unsupported_version',
      `unsupported protocol version ${record.v}`,
      id
    )
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new QueuedProtocolError('bad_request', "field 'id' must be a non-empty string", id)
  }
  if (!QUEUED_METHODS.some(method => method === record.method)) {
    throw new QueuedProtocolError('bad_request', `unknown method '${String(record.method)}'`, id)
  }
  return {
    v: record.v,
    id: record.id,
    method: record.method as QueuedMethod,
    params: record.params
  }
}

/**
 * Extracts the raw wire record an `ingest` request carries in `params.record`. The record itself is
 * validated downstream (by the record codec / engine), so this only unwraps the envelope. Throws
 * {@link QueuedProtocolError} (`bad_request`) when `params` is not `{ record: … }`.
 */
export function ingestRecord(params: unknown, id = ''): unknown {
  if (
    typeof params !== 'object' ||
    params === null ||
    Array.isArray(params) ||
    !('record' in params)
  ) {
    throw new QueuedProtocolError('bad_request', 'ingest params must be { record: … }', id)
  }
  return (params as { record: unknown }).record
}

/** Serializes a response to a single newline-terminated line ready to write to the socket. */
export function serializeResponse(response: QueuedResponse): string {
  return `${JSON.stringify(response)}\n`
}

/** Builds a success response envelope. */
export function okResponse(id: string, result: unknown): QueuedResponse {
  return { v: QUEUED_PROTOCOL_VERSION, id, result }
}

/** Builds an error response envelope. */
export function errorResponse(id: string, code: QueuedErrorCode, message: string): QueuedResponse {
  return { v: QUEUED_PROTOCOL_VERSION, id, error: { code, message } }
}

const ERROR_CODES: readonly QueuedErrorCode[] = [
  'bad_request',
  'unsupported_version',
  'chain_mismatch',
  'retry',
  'internal'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Validated narrow of a socket line into the response envelope: the version we speak, exactly one of
 * `result`/`error`, and a well-formed error body. The client uses this to reject a malformed line
 * before trusting either branch; deeper result shapes are checked at the use site.
 */
export function isQueuedResponse(value: unknown): value is QueuedResponse {
  if (!isRecord(value) || value.v !== QUEUED_PROTOCOL_VERSION) return false
  if ('error' in value) {
    if ('result' in value) return false
    const { error } = value
    return (
      isRecord(error) &&
      typeof error.message === 'string' &&
      ERROR_CODES.some(code => code === error.code)
    )
  }
  return 'result' in value
}
