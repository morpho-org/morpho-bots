import type { Abi, Hex } from 'viem'

import { BaseError, decodeErrorResult, ExecutionRevertedError, RpcRequestError } from 'viem'

const isExecutionRevert = (error: unknown): boolean => {
  if (!(error instanceof BaseError)) return false
  if (error.walk(e => e instanceof ExecutionRevertedError) !== null) return true
  // Some transports surface the canonical message without viem's typed subclass.
  return /execution reverted/i.test(error.shortMessage)
}

/**
 * True if `error` is an onchain execution revert (the call cannot succeed) rather than a transient
 * RPC/network error, including a raw `eth_call` that reports a revert as a JSON-RPC error.
 */
export const isCallRevert = (error: unknown): boolean =>
  isExecutionRevert(error) ||
  (error instanceof BaseError &&
    error.walk(e => e instanceof RpcRequestError && /execution reverted/i.test(e.details)) !== null)

/** The ABI-encoded revert payload a node returned, if any (searched across the viem error chain). */
const revertData = (error: BaseError): Hex | undefined => {
  const withData = error.walk(e => typeof (e as { data?: unknown }).data === 'string') as {
    data?: Hex
  } | null
  return withData?.data?.startsWith('0x') ? withData.data : undefined
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
 * A concise failure reason: the decoded revert (via `decode`, defaulting to the standard
 * `Error`/`Panic` shapes) when the revert carries data, else viem's short message. Never includes
 * the request/calldata dump that bloats `error.message` (and gets truncated by log shippers).
 * Plain errors keep their message, so trust-boundary logs must redact it or use a safer fallback.
 * Protocols with custom ABI errors pass `abiRevertDecoder(theirAbi)`.
 */
export const revertReason = (
  error: unknown,
  decode: RevertDecoder = decodeStandardRevert
): string => {
  if (!(error instanceof BaseError)) {
    return error instanceof Error ? error.message : String(error)
  }
  const data = revertData(error)
  if (data) {
    try {
      return decode(data)
    } catch {
      // Not an error shape the decoder knows — fall through to viem's short message.
    }
  }
  return error.shortMessage
}
