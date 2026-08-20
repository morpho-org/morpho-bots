import type { Logger } from '@repo/bot-kit'
import type { Address } from 'viem'

import type { VaultV2Data } from './vault-data'

export type VaultCheckReads = {
  /** Fatal liveness gate; throws when the address holds no code on this chain. */
  assertDeployed: (vault: Address) => Promise<void>
  /**
   * Block-pinned lens fetch; throws `InvalidVaultError` when the address is not a
   * factory-made VaultV2 with exactly one Morpho Blue market adapter. Carries the EOA's strict
   * `isAllocator` bit (VaultV2.allocate admits no curator/owner fallback), and the adapter comes
   * from the vault's own `adapters` enumeration, so no recognition cross-check is needed.
   */
  fetchVault: (vault: Address) => Promise<VaultV2Data>
}

/**
 * Startup validation of the whitelist, run concurrently across vaults: each must hold code and
 * resolve as a factory-made VaultV2 with exactly one Morpho Blue market adapter — the signing
 * policy authorizes every whitelisted address as a tx target and pins its adapter, so any mismatch
 * throws `InvalidVaultError`. The allocator role is only probed and warned about
 * (`allocator.missing_role`): a pending grant must not crash-loop the bot, and the tick re-checks
 * and resumes on its own. Returns the vault → adapter map the signing policy binds to.
 */
export const checkVaults = async (
  vaults: readonly Address[],
  reads: VaultCheckReads,
  logger: Logger
): Promise<Record<Address, readonly Address[]>> => {
  const entries = await Promise.all(
    vaults.map(async vault => {
      await reads.assertDeployed(vault)
      const vaultData = await reads.fetchVault(vault)
      if (!vaultData.isAllocator) {
        logger.warn('allocator.missing_role', {
          vault,
          detail: 'grant the allocator role to the EOA'
        })
      }
      return [vault, [vaultData.adapterAddress]] as const
    })
  )
  return Object.fromEntries(entries)
}
