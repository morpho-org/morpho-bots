import type { KeyedWrite } from '@repo/engine'
import type { KernelHead } from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { Address, Hex } from 'viem'

import { tryCatch } from '@repo/utils'

import type { VaultReading } from './reallocation'
import type { VaultV2Result } from './vault-data'

import { revertReason } from './revert.utils'

export type WorldDeps = Readonly<{
  vaults: readonly Address[]
  /** Reads every vault pinned to `blockHash`; a vault missing from the map was not served. */
  fetchVaults: (vaults: readonly Address[], blockHash: Hex) => Promise<Map<string, VaultV2Result>>
}>

/**
 * Reads every whitelisted vault at the kernel's head `at`. A vault the lens did not serve, or
 * served in a shape the bot does not support, is failed with its reason; only a read that served
 * every vault vouches for the whole whitelist.
 */
const readVaults = async (
  at: KernelHead,
  deps: WorldDeps
): Promise<
  Readonly<{ write: KeyedWrite<VaultReading>; unread: Readonly<Record<string, string>> }>
> => {
  const rows = await deps.fetchVaults(deps.vaults, at.hash as Hex)
  const entries: Record<string, VaultReading> = {}
  const unread: Record<string, string> = {}
  for (const vault of deps.vaults) {
    const row = rows.get(vault.toLowerCase())
    if (row?.data) entries[vault] = { ...row.data, block: at.number }
    else
      unread[vault] = row?.error ? revertReason(row.error) : 'lens returned no row for this vault'
  }
  const failed = Object.keys(unread)
  const basis = { block: at.number, blockHash: at.hash }
  return {
    unread,
    write:
      failed.length === 0
        ? { coverage: 'complete', entries, basis }
        : { coverage: 'carried', entries, failed, basis }
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
    for (const [vault, reason] of Object.entries(read.data.unread))
      logger.error('vault.error', { vault, reason })
    return read.data.write
  }
