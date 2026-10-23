/** Raised when a required env var is missing or malformed — the bot must fail loud at startup. */
export class InvalidConfigError extends Error {
  readonly code = 'invalid_config'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidConfigError'
  }
}
