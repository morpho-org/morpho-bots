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
