/** Raised when write-mode composition is missing resolver signing authority. */
export class ResolverPrivateKeyRequiredError extends Error {
  /** Creates a credential-free configuration invariant failure. */
  constructor() {
    super('Write mode requires a resolver private key')
  }
}
