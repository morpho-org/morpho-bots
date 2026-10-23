/** A call a validator cannot read exactly; its message is the refusal reason. */
export class UnreadableCallError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'UnreadableCallError'
  }
}

/** A validator's configuration is ambiguous or malformed, so it refuses to be built. */
export class InvalidValidatorConfigError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'InvalidValidatorConfigError'
  }
}
