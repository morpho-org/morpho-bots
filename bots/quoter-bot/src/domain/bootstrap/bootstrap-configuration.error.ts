/** Identifies an unsafe bootstrap strategy setting before an offer is derived. */
export class BootstrapConfigurationError extends Error {
  override readonly name = 'BootstrapConfigurationError'

  /**
   * Creates a safe field-scoped strategy configuration failure.
   * @param field - Non-secret configuration field that failed validation.
   * @param reason - Stable operator-facing reason without rejected provider or secret values.
   */
  constructor(
    readonly field: string,
    readonly reason: string
  ) {
    super(`${field} ${reason}`)
  }
}
