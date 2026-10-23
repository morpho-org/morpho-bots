import type { Address, Hex } from 'viem'

/** Raised when a required env var is missing or malformed — the bot must fail loud at startup. */
export class InvalidConfigError extends Error {
  readonly code = 'invalid_config'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidConfigError'
  }
}

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

/** A strategy allocated to a market the vault's read does not list: a strategy bug, never acted on. */
export class UnlistedMarketError extends Error {
  constructor(vault: Address, market: Hex) {
    super(`strategy allocated vault ${vault} to unlisted market ${market}`)
    this.name = 'UnlistedMarketError'
  }
}
