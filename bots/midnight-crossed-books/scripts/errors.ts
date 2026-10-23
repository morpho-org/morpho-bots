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

/** Raised when secret-safe Railway API operations have no supported API credential. */
export class RailwayAccessTokenRequiredError extends Error {
  /** Creates a credential-free provisioning failure. */
  constructor() {
    super('RAILWAY_TOKEN or RAILWAY_API_TOKEN is required for safe Railway variable deletion')
    this.name = 'RailwayAccessTokenRequiredError'
  }
}

type RailwayVariableOperation = 'delete' | 'set'

/** Raised when a Railway variable operation fails without exposing variable values. */
export class RailwayVariableOperationError extends Error {
  /**
   * Creates a secret-safe CLI operation failure.
   * @param operation - Failed Railway operation.
   * @param variableName - Variable name for a targeted operation; never a value.
   */
  constructor(operation: RailwayVariableOperation, variableName?: string) {
    super(
      variableName
        ? `Failed to ${operation} Railway variable ${variableName}`
        : `Failed to ${operation} Railway variables`
    )
    this.name = 'RailwayVariableOperationError'
  }
}
