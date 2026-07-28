/** Signals that one or more source declarations violate the enforced JSDoc contract. */
export class JSDocValidationError extends Error {
  /**
   * Creates a tooling failure from a count only, without retaining source contents or environment data.
   * @param failureCount - Number of deterministic documentation-rule violations found.
   */
  constructor(readonly failureCount: number) {
    super(`JSDoc contract coverage failed for ${failureCount} rules`)
    this.name = 'JSDocValidationError'
  }
}
