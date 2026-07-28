/** Signals invalid CLI usage while preserving only a safe command label and optional internal cause. */
export class CliUsageError extends Error {
  /**
   * Creates a deterministic CLI usage failure suitable for the process boundary.
   * @param command - Safe command label, never raw arguments that may contain credentials.
   * @param message - Commander-compatible operator-facing usage message.
   * @param options - Optional internal cause; it is not included in serialized CLI output.
   */
  constructor(
    readonly command: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'CliUsageError'
  }
}
