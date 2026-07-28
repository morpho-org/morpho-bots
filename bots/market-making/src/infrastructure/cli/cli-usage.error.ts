/** Signals invalid CLI usage without retaining user-controlled arguments or Commander details. */
export class CliUsageError extends Error {
  readonly code = 'INVALID_USAGE' as const
  readonly kind = 'usage' as const

  /**
   * Creates a deterministic usage failure containing only stable allowlisted fields.
   * @remarks Raw arguments, command text, option names/values, URLs, and nested causes are discarded.
   */
  constructor() {
    super('Invalid command-line usage')
    this.name = 'CliUsageError'
  }
}
