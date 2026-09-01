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
