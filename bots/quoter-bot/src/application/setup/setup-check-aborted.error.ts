/** Signals that startup readiness stopped because shutdown interrupted a transient provider retry. */
export class SetupCheckAbortedError extends Error {
  /** Creates a fixed, sanitized abort error for an interrupted setup check. */
  constructor() {
    super('Setup check aborted')
    this.name = 'AbortError'
  }
}
