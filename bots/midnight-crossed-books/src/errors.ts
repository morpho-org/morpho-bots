/** Raised when an operator-provided runtime value cannot be used safely. */
export class InvalidConfigurationError extends Error {}

/** Raised when a simulation caller is missing, malformed, or the zero address. */
export class InvalidSimulationCallerAddressError extends InvalidConfigurationError {
  /** Creates a credential-free caller validation failure. */
  constructor() {
    super('SIMULATION_CALLER_ADDRESS must be a public non-zero EVM address')
    this.name = 'InvalidSimulationCallerAddressError'
  }
}

/** Raised when write-mode composition is missing resolver signing authority. */
export class ResolverPrivateKeyRequiredError extends Error {
  /** Creates a credential-free configuration invariant failure. */
  constructor() {
    super('Write mode requires a resolver private key')
  }
}

/**
 * Raised when the listed-markets walk stopped at its page cap with a cursor still outstanding.
 *
 * The listed set is a handful of markets, so reaching the cap means the endpoint returned a runaway
 * cursor rather than that the set grew. Resolving crossed books against a silently partial market
 * list would skip real crossings with no signal, so this fails the fetch instead.
 */
export class TruncatedMarketListError extends Error {
  readonly code = 'truncated_market_list'
  readonly pages: number

  constructor(pages: number) {
    super(`Listed-markets pagination stopped at ${pages} pages with a cursor still outstanding`)
    this.name = 'TruncatedMarketListError'
    this.pages = pages
  }
}

interface UpstreamApiErrorParameters {
  endpoint: string
  status?: number
  cause?: unknown
}

class UpstreamApiError extends Error {
  readonly endpoint: string
  readonly status: number | undefined

  constructor(
    name: string,
    message: string,
    { endpoint, status, cause }: UpstreamApiErrorParameters
  ) {
    super(message, { cause })
    this.name = name
    this.endpoint = endpoint
    this.status = status
  }
}

export class MorphoApiError extends UpstreamApiError {
  constructor(parameters: UpstreamApiErrorParameters) {
    super('MorphoApiError', `Morpho API request failed: ${parameters.endpoint}`, parameters)
  }
}

export class RouterApiError extends UpstreamApiError {
  constructor(parameters: UpstreamApiErrorParameters) {
    super('RouterApiError', `Router API request failed: ${parameters.endpoint}`, parameters)
  }
}

/** Raised when a readonly resolver transport is asked to mutate chain state. */
export class ReadonlyMutationError extends Error {
  /** Creates a credential-free, operator-safe readonly mutation failure. */
  constructor() {
    super('Readonly resolver transport cannot submit transactions')
  }
}
