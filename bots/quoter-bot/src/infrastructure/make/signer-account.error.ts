/** Sanitized signer-construction or remote-signing failure. */
export class SignerAccountError extends Error {
  readonly name = 'SignerAccountError'

  /**
   * Creates a sanitized account failure from an allowlisted operation only.
   * @param operation - Stable signer operation that failed without retaining secret material.
   */
  constructor(
    readonly operation:
      | 'signer-address'
      | 'keystore-read'
      | 'keystore-decrypt'
      | 'kms-public-key'
      | 'kms-sign'
  ) {
    super(`Signer account ${operation} failed`)
  }
}
