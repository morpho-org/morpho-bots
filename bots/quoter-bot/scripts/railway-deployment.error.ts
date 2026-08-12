/** Signals a sanitized Railway provisioning, deployment, or confirmation failure. */
export class RailwayDeploymentError extends Error {
  /**
   * Creates an operator-safe deployment failure without retaining CLI output or runtime values.
   * @param message - Fixed diagnostic describing the failed deployment phase.
   */
  constructor(message: string) {
    super(message)
    this.name = 'RailwayDeploymentError'
  }
}
