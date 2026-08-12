/** Raised when a readonly resolver transport is asked to mutate chain state. */
export class ReadonlyMutationError extends Error {
  /** Creates a credential-free, operator-safe readonly mutation failure. */
  constructor() {
    super('Readonly resolver transport cannot submit transactions')
  }
}
