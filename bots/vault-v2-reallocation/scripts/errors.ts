/** Signals that the production bundle could not be produced. */
export class BundleFailedError extends Error {
  /**
   * Creates a tooling failure from the bundler's own message, without retaining source contents.
   * @param detail - Bundler-reported reason for the failure.
   */
  constructor(readonly detail: string) {
    super(`Bundle failed: ${detail}`)
    this.name = 'BundleFailedError'
  }
}

/** Raised when the lens probe's environment is missing or malformed — the script must fail loud. */
export class InvalidProbeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidProbeConfigError'
  }
}
