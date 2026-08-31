import type { Abi, Hex } from 'viem'

import { BaseError, decodeErrorResult, ExecutionRevertedError, size, slice } from 'viem'

import { TxSendError } from './tx-send.error'

const SELECTOR_BYTES = 4

const unwrapSendError = (error: unknown): unknown =>
  error instanceof TxSendError ? error.originalError : error

/**
 * True if `error` is an on-chain execution revert (the tx cannot succeed) rather than a transient
 * RPC/network error (timeout, HTTP, nonce). The pending queue uses this to decide whether a stuck
 * tx should be dropped (a revert won't fix itself, so bumping is futile) or retried (transient). It
 * is also what the queue reports as `SubmitOutcome.executionRevert`, so a bot whose incentive ramps
 * on wall-clock decides on this predicate alone whether a failed send suppresses the position.
 */
export const isExecutionRevert = (error: unknown): boolean => {
  const unwrapped = unwrapSendError(error)
  if (!(unwrapped instanceof BaseError)) return false
  if (unwrapped.walk(e => e instanceof ExecutionRevertedError) !== null) return true
  // Some transports surface the canonical message without viem's typed subclass.
  return /execution reverted/i.test(unwrapped.shortMessage)
}

/** The ABI-encoded revert payload a node returned, if any (searched across the viem error chain). */
const revertData = (error: BaseError): Hex | undefined => {
  const withData = error.walk(e => typeof (e as { data?: unknown }).data === 'string') as {
    data?: Hex
  } | null
  return withData?.data?.startsWith('0x') ? withData.data : undefined
}

/**
 * The revert payload's 4-byte selector, or `undefined` when the error carries no payload (or one too
 * short to hold a selector). Attributes a revert that {@link revertReason} could not decode, since
 * the selector identifies the reverting contract's error even when no ABI in reach defines it.
 */
export const revertSelector = (error: unknown): Hex | undefined => {
  const unwrapped = unwrapSendError(error)
  if (!(unwrapped instanceof BaseError)) return undefined
  const data = revertData(unwrapped)
  if (!data || size(data) < SELECTOR_BYTES) return undefined
  return slice(data, 0, SELECTOR_BYTES)
}

/**
 * Decodes an ABI-encoded revert payload to a log-safe string. May throw on an unknown selector —
 * {@link revertReason} falls through to viem's short message when it does.
 */
export type RevertDecoder = (data: Hex) => string

// Standard Solidity reverts: `Error(string)` (require/revert strings) and `Panic(uint256)`
// (arithmetic underflow etc.). Protocols without custom ABI errors revert exclusively with these.
const SOLIDITY_ERRORS = [
  { type: 'error', name: 'Error', inputs: [{ type: 'string' }] },
  { type: 'error', name: 'Panic', inputs: [{ type: 'uint256' }] }
] as const

/** Decodes standard Solidity reverts: `Error(string)` → the string, `Panic(uint256)` → `Panic(code)`. */
const decodeStandardRevert: RevertDecoder = data => {
  const { errorName, args } = decodeErrorResult({ abi: SOLIDITY_ERRORS, data })
  if (errorName === 'Error') return args?.[0] ?? errorName
  if (errorName === 'Panic') return `Panic(${args?.[0]})`
  return errorName
}

/**
 * Builds a {@link RevertDecoder} for a protocol's custom ABI errors, formatted `Name(arg, arg)`.
 * viem's `decodeErrorResult` also handles the standard `Error`/`Panic` selectors with a custom ABI,
 * so the returned decoder covers standard reverts too.
 */
export const abiRevertDecoder =
  (abi: Abi): RevertDecoder =>
  data => {
    const { errorName, args } = decodeErrorResult({ abi, data })
    return args && args.length > 0 ? `${errorName}(${args.join(', ')})` : errorName
  }

/**
 * A concise, log-safe failure reason: the decoded revert (via `decode`, defaulting to the standard
 * `Error`/`Panic` shapes) when the revert carries data, else viem's short message. Never includes
 * the request/calldata dump that bloats `error.message` (and gets truncated by log shippers).
 * Protocols with custom ABI errors pass `abiRevertDecoder(theirAbi)`.
 */
export const revertReason = (
  error: unknown,
  decode: RevertDecoder = decodeStandardRevert
): string => {
  const unwrapped = unwrapSendError(error)
  if (!(unwrapped instanceof BaseError)) {
    return unwrapped instanceof Error ? unwrapped.message : String(unwrapped)
  }
  const data = revertData(unwrapped)
  if (data) {
    try {
      return decode(data)
    } catch {
      // Not an error shape the decoder knows — fall through to viem's short message.
    }
  }
  return unwrapped.shortMessage
}
