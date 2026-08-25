/** Signals that the publishable npm package could not be staged. */
export class NpmPackFailedError extends Error {
  /**
   * Creates a tooling failure describing the packaging step that could not complete.
   * @param message - Fixed diagnostic describing the failed packaging phase.
   */
  constructor(message: string) {
    super(message)
    this.name = 'NpmPackFailedError'
  }
}
