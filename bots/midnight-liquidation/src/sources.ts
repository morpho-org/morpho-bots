import type { KeyedWrite } from '@repo/engine'
import type { KernelHead } from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { Address, Hex } from 'viem'

import { lensKey, tryCatch } from '@repo/utils'

import type { BorrowerCandidate } from './discovery/borrowers'
import type { PositionReading } from './liquidation'
import type { LensInput, LensOut } from './state/lens.sol'

import { revertReason } from './revert.utils'
import { isLiquidatable } from './runner/eligibility'

export type WorldDeps = Readonly<{
  discover: () => Promise<Readonly<{ candidates: readonly BorrowerCandidate[]; complete: boolean }>>
  /** Reads the lens pinned to `at` by its hash, so it can never answer from another fork. */
  readLens: (pairs: readonly LensInput[], at: KernelHead) => Promise<Map<string, LensOut>>
  /** The Executor: the `liquidate` caller whose gate the lens checks. */
  caller: Address
  onHead?: (head: KernelHead) => void
  logger: Logger
}>

/** The market whitelist as it stands when the read runs, with what an empty one reports. */
export type Whitelist = Readonly<{
  isListed: (marketId: Hex) => boolean
  fresh: number
  maxAgeMs: number
  sources: readonly Readonly<Record<string, unknown>>[]
}>

/** One world read: what it writes, and how many pairs discovery handed the lens. */
type WorldRead = Readonly<{ write: KeyedWrite<PositionReading>; pairs: number }>

const failed = (reason: string): WorldRead => ({
  write: { coverage: 'failed', reason },
  pairs: 0
})

/**
 * Reads every liquidatable position in a listed market at `at`. A failed read or an expired whitelist
 * changes no position, and only a complete discovery and lens read vouch for what they did not
 * return. The whitelist scopes the read as `docs/framework/AUTHORING.md` §4 describes.
 */
export const readWorld = async (
  at: KernelHead,
  whitelist: Whitelist,
  deps: WorldDeps
): Promise<WorldRead> => {
  const { logger } = deps
  deps.onHead?.(at)
  if (whitelist.fresh === 0) {
    logger.warn('markets.whitelist_expired', {
      maxAgeMs: whitelist.maxAgeMs,
      sources: whitelist.sources,
      detail:
        'every markets source is older than max age — whitelist is empty (fail-closed) until a refresh lands'
    })
    return { write: { coverage: 'unknown', reason: 'whitelist' }, pairs: 0 }
  }
  const discovered = await tryCatch(deps.discover())
  if (discovered.error) {
    logger.warn('discover.error', { error: revertReason(discovered.error) })
    return failed('discovery')
  }
  const { candidates } = discovered.data
  const listed = candidates.filter(candidate => whitelist.isListed(candidate.marketId))
  if (listed.length < candidates.length)
    logger.info('discover.filtered', {
      total: candidates.length,
      listed: listed.length,
      skippedMarkets: [
        ...new Set(
          candidates
            .filter(candidate => !whitelist.isListed(candidate.marketId))
            .map(candidate => candidate.marketId)
        )
      ]
    })
  const pairs = listed.map(({ marketId, borrower }) => ({
    id: marketId,
    borrower,
    caller: deps.caller
  }))
  const lens = await tryCatch(deps.readLens(pairs, at))
  if (lens.error) {
    logger.warn('tick.error', { reason: revertReason(lens.error) })
    return failed('lens')
  }
  logger.info('lens.read', { pairs: pairs.length, returned: lens.data.size })
  const entries: Record<string, PositionReading> = {}
  const absent: string[] = []
  const unread: string[] = []
  for (const pair of pairs) {
    const key = lensKey(pair.id, pair.borrower)
    const out = lens.data.get(key)
    if (!out?.valid) unread.push(key)
    else if (isLiquidatable(out))
      entries[key] = { marketId: pair.id, borrower: pair.borrower, out, block: at.number }
    else absent.push(key)
  }
  const basis = { block: at.number, blockHash: at.hash }
  const empty = Object.keys(entries).length === 0
  return {
    pairs: pairs.length,
    write:
      discovered.data.complete && unread.length === 0
        ? { coverage: 'complete', entries, basis, ...(empty && { empty: true as const }) }
        : { coverage: 'carried', entries, absent, failed: unread, basis }
  }
}
