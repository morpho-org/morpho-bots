/** Sanitized Midnight Mempool policy issue retained at the infrastructure boundary. */
export type BootstrapMempoolValidationIssue = {
  rule: string
  minimumAssets?: bigint
}

/** Expected rejection of a prospective bootstrap offer by Midnight Mempool policy. */
export class BootstrapMempoolValidationError extends Error {
  readonly code = 'BOOTSTRAP_MEMPOOL_VALIDATION_FAILED'
  readonly kind = 'validation-error'
  readonly minimumAssets?: bigint

  /**
   * Creates a sanitized policy failure without retaining provider messages or response bodies.
   * @param issues - Allowlisted rule names and safe numeric details returned by the boundary mapper.
   */
  constructor(readonly issues: readonly BootstrapMempoolValidationIssue[]) {
    super('Position bootstrap offer failed Midnight Mempool validation')
    this.name = 'BootstrapMempoolValidationError'
    this.minimumAssets = issues
      .map(issue => issue.minimumAssets)
      .filter((value): value is bigint => value !== undefined)
      .reduce<bigint | undefined>(
        (largest, value) => (largest === undefined || value > largest ? value : largest),
        undefined
      )
  }
}
