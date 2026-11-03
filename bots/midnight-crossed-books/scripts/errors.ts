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
