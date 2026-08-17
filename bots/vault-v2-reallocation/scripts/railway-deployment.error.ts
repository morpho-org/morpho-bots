/** Signals a sanitized Railway provisioning, deployment, or confirmation failure. */
export class RailwayDeploymentError extends Error {
  /**
   * Creates an operator-safe deployment failure without retaining CLI output or runtime values.
   * @param message - Fixed diagnostic describing the failed deployment phase.
   * @param options - Optional `cause` retaining the underlying CLI error for local debugging only.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RailwayDeploymentError'
  }
}
