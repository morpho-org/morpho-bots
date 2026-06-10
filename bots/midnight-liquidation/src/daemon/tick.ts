import type { Address } from 'viem'

import { assertNever } from '@repo/utils'

import type { MidnightApiClient } from '../api/client'
import type { BorrowerCandidate } from '../discovery/borrowers'
import type { Obligation } from '../execution/encode-call'
import type { SimulateResult } from '../execution/simulate'
import type { LensInput, LensOut } from '../lens/lens.sol'
import type { Logger } from '../logger'
import type { LiquidationPlan } from '../sizing/plan'

import { getChainStatuses } from '../api/chains'
import { lensKey } from '../lens/lens.sol'
import { plan } from '../sizing/plan'
import { isLiquidatable, planInputFromLens } from './eligibility'

type TickCounters = {
  pairs: number
  liquidatable: number
  planned: number
  ok: number
  unfunded: number
  reverted: number
  skipped: boolean
}

/**
 * One Phase-2 read-only tick: gate on indexer freshness, enumerate the indexed (id, borrower)
 * universe, read the liquidation lens fresh for the whole batch (one deployless `eth_call`), then
 * for each liquidatable position build a plan and sink it to a read-only `simulate` — no signer,
 * no queue. Deps are injected so the tick is unit-testable without a chain or Postgres:
 * `readLens` and `simulate` are the only chain-touching seams (wired in `index.ts`).
 */
export async function runTick(deps: {
  apiClient: MidnightApiClient
  discover: () => Promise<BorrowerCandidate[]>
  chainId: number
  /** The Executor singleton — the `liquidate` msg.sender whose gate the lens checks. */
  caller: Address
  readLens: (pairs: LensInput[]) => Promise<Map<string, LensOut>>
  simulate: (args: {
    obligation: Obligation
    borrower: Address
    plan: LiquidationPlan
  }) => Promise<SimulateResult>
  logger: Logger
}): Promise<TickCounters> {
  const { apiClient, discover, chainId, caller, readLens, simulate, logger } = deps
  const empty: TickCounters = {
    pairs: 0,
    liquidatable: 0,
    planned: 0,
    ok: 0,
    unfunded: 0,
    reverted: 0,
    skipped: true
  }

  // 1. Indexer staleness gate (unchanged from Phase 1).
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

  // 2. Discover the (id, borrower) universe → lens inputs (caller = the Executor singleton).
  const candidates = await discover()
  const pairs: LensInput[] = candidates.map(candidate => ({
    id: candidate.marketId,
    borrower: candidate.borrower,
    caller
  }))

  // 3. Read the lens fresh for the whole batch in one deployless eth_call.
  const lensOut = await readLens(pairs)
  logger.info('lens.read', {
    pairs: pairs.length,
    returned: lensOut.size,
    indexedBlock: status.latestIndexedBlock
  })

  const counters: TickCounters = {
    pairs: pairs.length,
    liquidatable: 0,
    planned: 0,
    ok: 0,
    unfunded: 0,
    reverted: 0,
    skipped: false
  }

  // 4. Compose liquidatability off-chain → plan → read-only simulate.
  for (const pair of pairs) {
    const out = lensOut.get(lensKey(pair.id, pair.borrower))
    if (!out || !isLiquidatable(out)) continue
    counters.liquidatable += 1

    const liquidationPlan = plan(planInputFromLens(out))
    if (!liquidationPlan) continue
    counters.planned += 1
    logger.info('plan.built', {
      marketId: pair.id,
      borrower: pair.borrower,
      collateralIndex: liquidationPlan.collateralIndex,
      seizedAssets: liquidationPlan.seizedAssets,
      repaidUnits: liquidationPlan.repaidUnits,
      postMaturityMode: liquidationPlan.postMaturityMode
    })

    const result = await simulate({
      obligation: out.obligation,
      borrower: pair.borrower,
      plan: liquidationPlan
    })
    const fields = { marketId: pair.id, borrower: pair.borrower }
    switch (result.status) {
      case 'ok':
        counters.ok += 1
        logger.info('simulate.ok', fields)
        break
      case 'unfunded':
        counters.unfunded += 1
        logger.info('simulate.unfunded', fields)
        break
      case 'revert':
        counters.reverted += 1
        logger.warn('simulate.revert', { ...fields, reason: result.reason })
        break
      default:
        assertNever(result.status)
    }
  }

  logger.info('tick.end', { ...counters })
  return counters
}
