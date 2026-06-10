import type { MidnightApiClient } from '../api/client'
import type { BorrowerCandidate } from '../discovery/borrowers'
import type { Logger } from '../logger'

import { getChainStatuses } from '../api/chains'
import { listBorrowPositions } from '../api/positions'

type DryRunCounters = { borrowers: number; positions: number; skipped: boolean }

/**
 * One Phase-1 dry-run tick: gate on indexer freshness, enumerate borrowers from the indexed
 * (market, borrower) universe, fetch each borrower's live borrow positions from the API, and log a
 * "would attempt" line per position. No lens, no signer — the lens-backed decision path lands in
 * Phase 2 (CRTR-2582). Deps are injected so the tick is unit-testable without a chain or Postgres.
 */
export async function runDryRunTick(deps: {
  apiClient: MidnightApiClient
  discover: () => Promise<BorrowerCandidate[]>
  chainId: number
  logger: Logger
}): Promise<DryRunCounters> {
  const { apiClient, discover, chainId, logger } = deps
  const empty: DryRunCounters = { borrowers: 0, positions: 0, skipped: true }

  const chains = await getChainStatuses(apiClient)
  if (chains.error) {
    logger.error('api.lag', { reason: chains.error.kind })
    return empty
  }
  const status = chains.data.find(chain => chain.chainId === chainId)
  if (!status) {
    logger.error('api.lag', { reason: 'chain_missing', chainId })
    return empty
  }
  if (status.activitySyncStatus === 'behind' || status.activitySyncStatus === 'no_activity') {
    logger.warn('api.lag', { chainId, status: status.activitySyncStatus })
    return empty
  }

  const candidates = await discover()
  const borrowers = [...new Set(candidates.map(candidate => candidate.borrower))]
  logger.info('positions.fetched', {
    borrowers: borrowers.length,
    indexedBlock: status.latestIndexedBlock
  })

  let positions = 0
  for (const borrower of borrowers) {
    const result = await listBorrowPositions(apiClient, { user: borrower, chainId })
    if (result.error) {
      logger.warn('discovery.skipped', { borrower, reason: result.error.kind })
      continue
    }
    for (const position of result.data) {
      positions += 1
      logger.info('would_attempt', { marketId: position.market_id, borrower, debt: position.debt })
    }
  }

  logger.info('tick.end', { borrowers: borrowers.length, positions })
  return { borrowers: borrowers.length, positions, skipped: false }
}
