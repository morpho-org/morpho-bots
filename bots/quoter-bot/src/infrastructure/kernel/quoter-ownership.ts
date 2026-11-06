import type { DurableEntry, Entry } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import { type Offer, Tree } from '@morpho-org/midnight-sdk'
import { decodeLedger, validateLedger } from '@repo/kernel'
import { midnightCommitmentGroup, midnightCommitmentId } from '@repo/validators'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAddress, isAddressEqual } from 'viem'

import type { KernelGroup, QuoterWorkflow } from '../../kernel'

import { StrategyStateVersionError, LedgerRefusedError } from '../../errors'
import { strategyStateDirectory } from '../strategy-state/strategy-state-file.utils'

const workflowOf = (intentId: string): QuoterWorkflow | undefined => {
  const prefix = intentId.split(':', 1)[0]
  return prefix === 'ladder' || prefix === 'bootstrap' || prefix === 'invalidation'
    ? prefix
    : undefined
}

/**
 * The offer groups behind kernel entries, each with the offers its stored witness names.
 * @param entries - Kernel entries, live or loaded from a ledger.
 * @param offersById - Offers already decoded per commitment; an entry's origin never changes.
 * @returns One group per entry that has left the process.
 */
export const kernelGroups = (
  entries: readonly Pick<Entry, 'spec' | 'state' | 'intentId' | 'origin'>[],
  offersById = new Map<string, readonly Offer[]>()
): KernelGroup[] =>
  entries.flatMap(entry => {
    if (entry.state === 'intended' || entry.state === 'signed' || !entry.origin) return []
    const groupId = midnightCommitmentGroup(entry.spec.id).toLowerCase() as Hex
    if (midnightCommitmentId(groupId) !== entry.spec.id) return []
    let offers = offersById.get(entry.spec.id)
    if (!offers) {
      offers = Tree.create(entry.origin.witness as never).offers.filter(
        offer => offer.group.toLowerCase() === groupId
      )
      offersById.set(entry.spec.id, offers)
    }
    const workflow = workflowOf(entry.intentId)
    return [{ groupId, state: entry.state, offers, ...(workflow ? { workflow } : {}) }]
  })

/**
 * Reads one maker's open kernel entries from every ledger for a chain, for runs with no kernel.
 * @param chainId - Configured chain.
 * @param maker - Configured maker; a maker may sign through several authorized signers' ledgers.
 * @param directory - State directory override used by tests.
 * @returns The maker's entries the ledgers record as exposed, live, or being withdrawn, by id.
 * @throws `StrategyStateVersionError` when a ledger cannot be read or decoded, and
 * `LedgerRefusedError` when the kernel's validation refuses one.
 */
export const readLedgerEntries = async (
  chainId: number,
  maker: Address,
  directory?: string
): Promise<Record<string, Entry>> => {
  const root = strategyStateDirectory(directory)
  let names: string[]
  try {
    names = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new StrategyStateVersionError()
  }
  const prefix = `kernel-${chainId}-`
  const ledgers = names.filter(name => name.startsWith(prefix) && name.endsWith('.json'))
  const stored: DurableEntry[] = []
  for (const name of ledgers) {
    let ledger: ReturnType<typeof validateLedger>
    try {
      const account = getAddress(name.slice(prefix.length, -'.json'.length))
      ledger = validateLedger(decodeLedger(await readFile(join(root, name), 'utf8')), {
        chainId,
        account
      })
    } catch {
      throw new StrategyStateVersionError()
    }
    if (typeof ledger === 'string') throw new LedgerRefusedError(ledger)
    stored.push(...Object.values(ledger.entries))
  }
  const entries: Record<string, Entry> = {}
  for (const { affirmedBy, ...rest } of stored) {
    const entry: Entry = { ...rest, recoveryAttempts: 0, stuck: false, affirmedAt: affirmedBy }
    try {
      const [group] = kernelGroups([entry])
      if (group?.offers.some(offer => isAddressEqual(offer.maker, maker)))
        entries[entry.spec.id] = entry
    } catch {
      throw new StrategyStateVersionError()
    }
  }
  return entries
}

/**
 * Reads one maker's groups from every kernel ledger for a chain, for commands that run no kernel.
 * @param chainId - Chain whose ledgers are read.
 * @param maker - Maker whose groups are kept.
 * @param directory - State directory override used by tests.
 * @returns The maker's groups the ledgers record as exposed, live, or being withdrawn.
 * @throws `StrategyStateVersionError` when a ledger cannot be read or decoded.
 */
export const readLedgerGroups = async (
  chainId: number,
  maker: Address,
  directory?: string
): Promise<KernelGroup[]> =>
  kernelGroups(Object.values(await readLedgerEntries(chainId, maker, directory)))
