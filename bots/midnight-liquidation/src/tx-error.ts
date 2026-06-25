import type { Hex } from 'viem'

import { MidnightAbi } from '@repo/contracts'
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

/**
 * A concise, log-safe failure reason: the decoded Midnight custom error when the revert carries
 * data, else viem's short message. Never includes the request/calldata dump that bloats
 * `error.message` (and gets truncated by log shippers).
 */
export function revertReason(error: unknown): string {
  error = unwrapSendError(error)
  if (!(error instanceof BaseError)) return error instanceof Error ? error.message : String(error)
  const data = revertData(error)
  if (data) {
    try {
      const { errorName, args } = decodeErrorResult({ abi: MidnightAbi, data })
      return args && args.length > 0 ? `${errorName}(${args.join(', ')})` : errorName
    } catch {
      // Not a known Midnight error — fall through to viem's short message.
    }
  }
  return error.shortMessage
}
