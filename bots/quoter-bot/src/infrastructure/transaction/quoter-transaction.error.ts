/** Sanitized failure from the guarded quoter transaction lifecycle. */
export class QuoterTransactionError extends Error {
  readonly name = 'QuoterTransactionError'

  /**
   * Creates a credential-free transaction lifecycle failure.
   * @param operation - Sanitized lifecycle stage that failed.
   */
  constructor(
    readonly operation:
      | 'configuration'
      | 'simulation-reverted'
      | 'submission-refused'
      | 'transaction-reverted'
      | 'transaction-dropped'
      | 'transaction-pending'
      | 'reconciliation-required'
      | 'unknown-pending-nonce'
  ) {
    super(`Quoter transaction ${operation}`)
  }
}
