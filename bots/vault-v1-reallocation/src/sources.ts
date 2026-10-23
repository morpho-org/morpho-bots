import type { KeyedWrite } from '@repo/engine'
import type { KernelHead } from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { Address, Hex } from 'viem'

import { tryCatch } from '@repo/utils'

import type { VaultReading } from './reallocation'
import type { VaultData } from './vault-data'

import { revertReason } from './revert.utils'

export type WorldDeps = Readonly<{
  vaults: readonly Address[]
  /** Reads every vault pinned to `blockHash`; a vault missing from the map was not served. */
  fetchVaults: (vaults: readonly Address[], blockHash: Hex) => Promise<Map<string, VaultData>>
}>

/**
 * Reads every whitelisted vault at the kernel's head `at`. A vault the lens did not serve is
 * failed; only a read that served every vault vouches for the whole whitelist.
 */
const readVaults = async (
  at: KernelHead,
  deps: WorldDeps
): Promise<Readonly<{ write: KeyedWrite<VaultReading>; unread: readonly Address[] }>> => {
  const rows = await deps.fetchVaults(deps.vaults, at.hash as Hex)
  const entries: Record<string, VaultReading> = {}
  const unread: Address[] = []
  for (const vault of deps.vaults) {
    const row = rows.get(vault.toLowerCase())
    if (row) entries[vault] = { ...row, block: at.number }
    else unread.push(vault)
  }
  const basis = { block: at.number, blockHash: at.hash }
  return {
    unread,
    write:
      unread.length === 0
        ? { coverage: 'complete', entries, basis }
        : { coverage: 'carried', entries, failed: unread, basis }
  }
}

/**
 * {@link readVaults} as the world source reads it. A vault the read did not serve is logged here,
 * where its reason is known; a read that throws fails with its reason.
 */
export const readWorld =
  (deps: WorldDeps, logger: Logger) =>
  async (head: KernelHead): Promise<KeyedWrite<VaultReading>> => {
    const read = await tryCatch(readVaults(head, deps))
    if (read.error) return { coverage: 'failed', reason: revertReason(read.error) }
    for (const vault of read.data.unread)
      logger.error('vault.error', { vault, reason: 'lens returned no row for this vault' })
    return read.data.write
  }
