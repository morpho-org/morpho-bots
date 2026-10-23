import type { PolicyCheck } from './policy'

/** Raised when a prepared transaction fails the default-deny policy — an upstream bug, never sent. */
export class PolicyViolationError extends Error {
  readonly code = 'policy_violation'

  constructor(
    message: string,
    readonly check: PolicyCheck
  ) {
    super(message)
    this.name = 'PolicyViolationError'
  }
}

/**
 * Raised by a sender that claimed a nonce but cannot derive a transaction hash to reconcile.
 * Account-backed bot-kit signers hash locally and do not use this path for RPC response loss.
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
