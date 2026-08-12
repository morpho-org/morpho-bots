/** Sanitized signer-construction or remote-signing failure. */
export class MakerAccountError extends Error {
  readonly name = 'MakerAccountError'

  /**
   * Creates a sanitized account failure from an allowlisted operation only.
   * @param operation - Stable signer operation that failed without retaining secret material.
   */
  constructor(
    readonly operation:
      | 'maker-address'
      | 'keystore-read'
      | 'keystore-decrypt'
      | 'kms-public-key'
      | 'kms-sign'
  ) {
    super(`Maker account ${operation} failed`)
  }
}
