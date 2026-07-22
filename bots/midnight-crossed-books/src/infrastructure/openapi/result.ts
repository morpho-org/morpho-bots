interface OpenApiResult<T> {
  data?: T
  error?: unknown
  response: Response
}

type UpstreamErrorConstructor = new (parameters: {
  endpoint: string
  status?: number
  cause?: unknown
}) => Error

export function unwrapOpenApiResult<T>(
  result: OpenApiResult<T>,
  endpoint: string,
  ErrorType: UpstreamErrorConstructor
): T {
  if (result.data !== undefined) return result.data

  throw new ErrorType({
    endpoint,
    status: result.response.status,
    cause: result.error
  })
}

export async function withOpenApiErrorBoundary<T>(
  endpoint: string,
  ErrorType: UpstreamErrorConstructor,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ErrorType) throw error
    throw new ErrorType({ endpoint, cause: error })
  }
}
