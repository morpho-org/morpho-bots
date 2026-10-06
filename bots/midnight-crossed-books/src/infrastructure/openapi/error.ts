interface UpstreamApiErrorParameters {
  endpoint: string
  status?: number
  cause?: unknown
}

// oxlint-disable-next-line repo/error-class-file
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

// oxlint-disable-next-line repo/error-class-file
export class MorphoApiError extends UpstreamApiError {
  constructor(parameters: UpstreamApiErrorParameters) {
    super('MorphoApiError', `Morpho API request failed: ${parameters.endpoint}`, parameters)
  }
}

// oxlint-disable-next-line repo/error-class-file
export class RouterApiError extends UpstreamApiError {
  constructor(parameters: UpstreamApiErrorParameters) {
    super('RouterApiError', `Router API request failed: ${parameters.endpoint}`, parameters)
  }
}
