/** Signals invalid runtime configuration without retaining the rejected value. */
export class ConfigValidationError extends Error {
  /**
   * Creates a configuration failure from safe field and reason identifiers.
   * @param field - Environment field name; never the field value.
   * @param reason - Stable validation reason containing no rejected input.
   * @param message - Operator-facing message that must not interpolate secrets or provider URLs.
   * @param options - Optional internal cause; callers must not serialize nested third-party errors.
   */
  constructor(
    readonly field: string,
    readonly reason: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ConfigValidationError'
  }
}
