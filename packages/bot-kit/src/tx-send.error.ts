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
