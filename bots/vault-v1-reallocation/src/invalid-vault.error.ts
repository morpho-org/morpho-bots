/**
 * Raised at startup when a whitelisted address does not answer the Vault V1 surface — the
 * policy would otherwise authorize transactions to an arbitrary contract.
 */
export class InvalidVaultError extends Error {
  readonly code = 'invalid_vault'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidVaultError'
  }
}
