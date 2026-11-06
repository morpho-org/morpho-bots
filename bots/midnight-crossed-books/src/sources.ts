import type { KeyedWrite } from '@repo/engine'
import type { KernelHead } from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { Hex } from 'viem'

import { isCallRevert } from '@repo/kit'
import { tryCatch } from '@repo/utils'

import type { ListedMarket, MarketId, TakeableBook } from './domain/order-book'

import { MatchingService } from './domain/matching.service'
import { ViemResolverEncoder } from './infrastructure/resolver/resolver.encoder'
import { revertReason } from './revert.utils'

/** A market whose books cross: the resolver calldata that crosses them, as simulated at one block. */
export type Resolution = Readonly<{ data: Hex; units: bigint; profit: bigint }>

export type ScanDeps = Readonly<{
  listMarkets: () => Promise<readonly ListedMarket[]>
  getBook: (marketId: MarketId) => Promise<TakeableBook>
  /** Calls the resolver with `data` as the executing account, pinned to `at`; rejects on a revert. */
  simulate: (data: Hex, at: KernelHead) => Promise<Hex>
  maxMatches: number
  minimumProfit: bigint
  logger: Logger
}>

const matching = new MatchingService()
const encoder = new ViemResolverEncoder()

/** One market's resolution at `at`, `absent` when its books do not cross profitably, or `failed`. */
const readMarket = async (
  marketId: MarketId,
  at: KernelHead,
  deps: ScanDeps
): Promise<Resolution | 'absent' | 'failed'> => {
  const { logger } = deps
  const book = await tryCatch(deps.getBook(marketId))
  if (book.error) {
    logger.warn('books.fetch_failed', { marketId, reason: revertReason(book.error) })
    return 'failed'
  }
  const matches = matching.match({ ...book.data, maxMatches: deps.maxMatches })
  if (matches.length === 0) return 'absent'
  const data = encoder.encode(matches, deps.minimumProfit)
  const simulated = await tryCatch(deps.simulate(data, at))
  if (simulated.error && isCallRevert(simulated.error)) {
    logger.info('match.not_profitable', { marketId, reason: revertReason(simulated.error) })
    return 'absent'
  }
  if (simulated.error) throw simulated.error
  const profit = encoder.decodeProfit(simulated.data)
  const units = matches.reduce((total, match) => total + match.units, 0n)
  logger.info('match.computed', { marketId, units, profit })
  return { data, units, profit }
}

/**
 * Every listed market's crossed books at `at`: each market whose resolution simulates profitably
 * there, as the account that would send it. A failed market list changes nothing; a market whose
 * book or simulation failed is failed, so only a read of every market vouches for the ones it did
 * not return.
 */
export const scanBooks = async (
  at: KernelHead,
  deps: ScanDeps
): Promise<KeyedWrite<Resolution>> => {
  const { logger } = deps
  const listed = await tryCatch(deps.listMarkets())
  if (listed.error) {
    logger.warn('tick.error', { reason: revertReason(listed.error) })
    return { coverage: 'failed', reason: 'markets' }
  }
  const entries: Record<string, Resolution> = {}
  const absent: string[] = []
  const failed: string[] = []
  for (const { marketId } of listed.data) {
    const read = await tryCatch(readMarket(marketId, at, deps))
    if (read.error) logger.warn('match.failed', { marketId, reason: revertReason(read.error) })
    if (read.error || read.data === 'failed') failed.push(marketId)
    else if (read.data === 'absent') absent.push(marketId)
    else entries[marketId] = read.data
  }
  const empty = Object.keys(entries).length === 0
  if (empty) logger.info('tick.no_match', { markets: listed.data.length })
  const basis = { block: at.number, blockHash: at.hash }
  return failed.length === 0
    ? { coverage: 'complete', entries, basis, ...(empty && { empty: true as const }) }
    : { coverage: 'carried', entries, absent, failed, basis }
}
