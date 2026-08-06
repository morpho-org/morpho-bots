/** Sanitized signer-construction or remote-signing failure. */
export class MakerAccountError extends Error {
  readonly name = 'MakerAccountError'

  constructor(
    readonly operation: 'keystore-read' | 'keystore-decrypt' | 'kms-public-key' | 'kms-sign'
  ) {
    super(`Maker account ${operation} failed`)
  }
}
