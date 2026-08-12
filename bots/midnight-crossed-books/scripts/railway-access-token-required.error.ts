/** Raised when secret-safe Railway API operations have no supported API credential. */
export class RailwayAccessTokenRequiredError extends Error {
  /** Creates a credential-free provisioning failure. */
  constructor() {
    super('RAILWAY_TOKEN or RAILWAY_API_TOKEN is required for safe Railway variable deletion')
    this.name = 'RailwayAccessTokenRequiredError'
  }
}
