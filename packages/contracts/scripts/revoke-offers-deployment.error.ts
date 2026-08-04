/** Sanitized deployment failure for invalid configuration or unsuccessful CREATE2 deployment. */
export class RevokeOffersDeploymentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RevokeOffersDeploymentError'
  }
}
