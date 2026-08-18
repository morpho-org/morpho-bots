import type { Logger } from '@repo/bot-kit'
import type { Address } from 'viem'

import { tryCatch } from '@repo/utils'

import { InvalidVaultError } from './invalid-vault.error'

export type VaultCheckReads = {
  /** Fatal liveness gate; throws when the address holds no code on this chain. */
  assertDeployed: (vault: Address) => Promise<void>
  /** A MetaMorpho V1-only read; rejecting marks the address as not a V1 vault. */
  readV1Surface: (vault: Address) => Promise<unknown>
  /** Full `onlyAllocatorRole` check for the reallocator EOA (allocator set, curator, or owner). */
  hasAllocatorRole: (vault: Address) => Promise<boolean>
}

/**
 * Startup validation of the whitelist: each vault must hold code and answer the MetaMorpho V1
 * surface — the signing policy authorizes every whitelisted address as a tx target, so a
 * non-MetaMorpho entry throws {@link InvalidVaultError}. The allocator role is only probed and
 * warned about (`allocator.missing_role`): a pending grant must not crash-loop the bot, and the tick
 * re-checks and resumes on its own.
 */
export const checkVaults = async (
  vaults: readonly Address[],
  reads: VaultCheckReads,
  logger: Logger
): Promise<void> => {
  for (const vault of vaults) {
    await reads.assertDeployed(vault)
    const surface = await tryCatch(reads.readV1Surface(vault))
    if (surface.error) {
      throw new InvalidVaultError(
        `VAULT_WHITELIST entry ${vault} does not answer the MetaMorpho V1 surface`
      )
    }
    const role = await tryCatch(reads.hasAllocatorRole(vault))
    if (role.error || !role.data) {
      logger.warn('allocator.missing_role', {
        vault,
        detail: 'grant the allocator role to the EOA'
      })
    }
  }
}
