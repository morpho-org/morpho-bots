import type { Hex } from 'viem'

import { BaseError, decodeErrorResult, ExecutionRevertedError } from 'viem'

/**
 * Raised by the signer when an initial broadcast fails after the bot has already claimed a nonce.
 * The tx hash is unknown, so the queue cannot track a pending hash; callers must treat this as a
 * tick-level failure and retry after the signer rolls its local nonce cursor back.
 */
export class TxSendError extends Error {
  readonly nonce: number | undefined
  readonly originalError: unknown

  constructor(error: unknown, nonce?: number) {
    super(error instanceof Error ? error.message : String(error))
    this.name = 'TxSendError'
    this.nonce = nonce
    this.originalError = error
  }
}

function unwrapSendError(error: unknown): unknown {
  return error instanceof TxSendError ? error.originalError : error
}

/**
 * True if `error` is an on-chain execution revert (the tx cannot succeed) rather than a transient
 * RPC/network error (timeout, HTTP, nonce). The pending queue uses this to decide whether a stuck
 * tx should be dropped (a revert won't fix itself, so bumping is futile) or retried (transient).
 */
export function isExecutionRevert(error: unknown): boolean {
  error = unwrapSendError(error)
  if (!(error instanceof BaseError)) return false
  if (error.walk(e => e instanceof ExecutionRevertedError) !== null) return true
  // Some transports surface the canonical message without viem's typed subclass.
  return /execution reverted/i.test(error.shortMessage)
}

/** The ABI-encoded revert payload a node returned, if any (searched across the viem error chain). */
function revertData(error: BaseError): Hex | undefined {
  const withData = error.walk(e => typeof (e as { data?: unknown }).data === 'string') as {
    data?: Hex
  } | null
  return withData?.data?.startsWith('0x') ? withData.data : undefined
}

// Morpho Blue reverts with standard `Error(string)` (its ErrorsLib strings, e.g. "market not
// created", "healthy position") and, on an over-seize / over-repay underflow, with `Panic(uint256)`
// (code 0x11). It has NO custom ABI errors, so decoding these two standard shapes covers every
// on-chain failure reason.
const SOLIDITY_ERRORS = [
  { type: 'error', name: 'Error', inputs: [{ type: 'string' }] },
  { type: 'error', name: 'Panic', inputs: [{ type: 'uint256' }] }
] as const

/**
 * A concise, log-safe failure reason: the decoded revert string / panic code when the revert carries
 * data, else viem's short message. Never includes the request/calldata dump that bloats
 * `error.message` (and gets truncated by log shippers).
 */
export function revertReason(error: unknown): string {
  error = unwrapSendError(error)
  if (!(error instanceof BaseError)) return error instanceof Error ? error.message : String(error)
  const data = revertData(error)
  if (data) {
    try {
      const { errorName, args } = decodeErrorResult({ abi: SOLIDITY_ERRORS, data })
      if (errorName === 'Error') return args?.[0] ?? errorName
      if (errorName === 'Panic') return `Panic(${args?.[0]})`
      return errorName
    } catch {
      // Not a standard Solidity error — fall through to viem's short message.
    }
  }
  return error.shortMessage
}
