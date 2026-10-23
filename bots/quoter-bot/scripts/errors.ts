/** Signals that the production bundle could not be produced. */
export class BundleFailedError extends Error {
  readonly detail: string

  /**
   * Creates a tooling failure from the bundler's own message, without retaining source contents.
   * @param detail - Bundler-reported reason for the failure.
   */
  constructor(detail: string) {
    super(`Bundle failed: ${detail}`)
    this.detail = detail
    this.name = 'BundleFailedError'
  }
}

/** Signals that one or more source declarations violate the enforced JSDoc contract. */
export class JSDocValidationError extends Error {
  readonly failureCount: number

  /**
   * Creates a tooling failure from a count only, without retaining source contents or environment data.
   * @param failureCount - Number of deterministic documentation-rule violations found.
   */
  constructor(failureCount: number) {
    super(`JSDoc contract coverage failed for ${failureCount} rules`)
    this.failureCount = failureCount
    this.name = 'JSDocValidationError'
  }
}

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

/** Signals that a semver precedence comparison received a malformed version. */
export class SemverPrecedenceError extends Error {
  /**
   * Creates a fixed-message comparison failure that never echoes the rejected input.
   * @remarks Compared values can originate from the npm registry, so the message stays constant.
   */
  constructor() {
    super('semver precedence comparison requires two plain (pre)release semver versions')
    this.name = 'SemverPrecedenceError'
  }
}
