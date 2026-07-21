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
