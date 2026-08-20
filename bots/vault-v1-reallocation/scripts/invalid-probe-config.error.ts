/** Raised when the lens probe's environment is missing or malformed — the script must fail loud. */
export class InvalidProbeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidProbeConfigError'
  }
}
