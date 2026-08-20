import type { Logger } from '@repo/bot-kit'
import type { Address } from 'viem'

import type { VaultV2Data } from './vault-data'

import { InvalidVaultError } from './invalid-vault.error'

export type VaultCheckReads = {
  /** Fatal liveness gate; throws when the address holds no code on this chain. */
  assertDeployed: (vault: Address) => Promise<void>
  /**
   * Block-pinned lens fetch; throws {@link InvalidVaultError} when the address is not a
   * factory-made VaultV2 with exactly one Morpho Blue market adapter. Carries the EOA's strict
   * `isAllocator` bit (VaultV2.allocate admits no curator/owner fallback).
   */
  fetchVault: (vault: Address) => Promise<VaultV2Data>
  /** `vault.isAdapter(adapter)` cross-check that the vault recognizes its fetched adapter. */
  isAdapter: (vault: Address, adapter: Address) => Promise<boolean>
}

/**
 * Startup validation of the whitelist: each vault must hold code, resolve as a factory-made VaultV2
 * with exactly one Morpho Blue market adapter, and recognize that adapter — the signing policy
 * authorizes every whitelisted address as a tx target and pins its adapter, so any mismatch throws
 * {@link InvalidVaultError}. The allocator role is only probed and warned about
 * (`allocator.missing_role`): a pending grant must not crash-loop the bot, and the tick re-checks
 * and resumes on its own. Returns the vault → adapter map the signing policy binds to.
 */
export const checkVaults = async (
  vaults: readonly Address[],
  reads: VaultCheckReads,
  logger: Logger
): Promise<Record<Address, readonly Address[]>> => {
  const adapterByVault: Record<Address, readonly Address[]> = {}
  for (const vault of vaults) {
    await reads.assertDeployed(vault)
    const vaultData = await reads.fetchVault(vault)
    const recognized = await reads.isAdapter(vault, vaultData.adapterAddress)
    if (!recognized) {
      throw new InvalidVaultError(
        `vault ${vault} does not recognize adapter ${vaultData.adapterAddress}`
      )
    }
    adapterByVault[vault] = [vaultData.adapterAddress]
    if (!vaultData.isAllocator) {
      logger.warn('allocator.missing_role', {
        vault,
        detail: 'grant the allocator role to the EOA'
      })
    }
  }
  return adapterByVault
}
