/** Raised when a discovery page has no `data` array, so the read cannot vouch for anything. */
export class MalformedPageError extends Error {
  constructor(source: string) {
    super(`${source} returned a page without a data array`)
    this.name = 'MalformedPageError'
  }
}

/** Raised when a required env var is missing or malformed — the bot must fail loud at startup. */
export class InvalidConfigError extends Error {
  readonly code = 'invalid_config'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidConfigError'
  }
}

/** Raised when the latest block carries no base fee, so a liquidation's gas cannot be priced. */
export class MissingBaseFeeError extends Error {
  constructor(chainId: number) {
    super(`chain ${chainId} reported a block without a base fee`)
    this.name = 'MissingBaseFeeError'
  }
}
