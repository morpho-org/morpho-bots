/** Some market's params could not be read, so discovery cannot say which positions it holds. */
export class MarketParamsReadError extends Error {
  constructor(unread: number) {
    super(`${unread} market params read(s) failed`)
    this.name = 'MarketParamsReadError'
  }
}

/** The candidates API answered with a 3xx or 4xx no retry fixes: the key or the URL is misconfigured. */
export class CandidatesApiRefusedError extends Error {
  constructor(status: number) {
    const reason =
      status < 400
        ? 'redirected the request'
        : status === 401 || status === 403
          ? 'rejected the API key'
          : 'refused the request'
    super(`liquidation-candidates ${reason} (HTTP ${status})`)
    this.name = 'CandidatesApiRefusedError'
  }
}

/** A candidates API response broke the page contract, so the walk cannot tell where it ends. */
export class CandidatesApiResponseError extends Error {
  constructor(problem: string) {
    super(`liquidation-candidates parse error: ${problem}`)
    this.name = 'CandidatesApiResponseError'
  }
}

/** A venue quote outlived its deadline, so it reads as failed. */
export class QuoteTimeoutError extends Error {
  constructor() {
    super('quote timed out')
    this.name = 'QuoteTimeoutError'
  }
}
