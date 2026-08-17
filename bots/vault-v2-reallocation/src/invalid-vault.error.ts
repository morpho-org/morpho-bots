/**
 * Raised when a whitelisted address is not a factory-made VaultV2 whose single adapter is a
 * MorphoMarketV1 adapter — the signing policy authorizes the address as a tx target, and the
 * strategies only understand that adapter shape.
 */
export class InvalidVaultError extends Error {
  readonly code = 'invalid_vault'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidVaultError'
  }
}
