/** Signals that startup readiness stopped because shutdown interrupted a transient provider retry. */
export class SetupCheckAbortedError extends Error {
  constructor() {
    super('Setup check aborted')
    this.name = 'AbortError'
  }
}
