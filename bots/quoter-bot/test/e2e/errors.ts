/** Expected failure while starting the local Anvil node used by the e2e suite. */
export class AnvilStartupError extends Error {
  /**
   * Creates a sanitized Anvil startup failure.
   *
   * @param message - Operator-safe description of the failed startup phase.
   * @param options - Optional underlying process or JSON-RPC failure.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AnvilStartupError'
  }
}
