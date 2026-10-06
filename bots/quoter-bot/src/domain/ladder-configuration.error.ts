/** Expected failure raised when a ladder shape or runtime decision violates a safety invariant. */
export class LadderConfigurationError extends Error {
  /**
   * Creates a sanitized ladder configuration failure.
   * @param field - Stable rejected field or derived-value name.
   * @param reason - Operator-safe invariant description with no untrusted input.
   */
  constructor(
    readonly field: string,
    readonly reason: string
  ) {
    super(`${field} ${reason}`)
    this.name = 'LadderConfigurationError'
  }
}
