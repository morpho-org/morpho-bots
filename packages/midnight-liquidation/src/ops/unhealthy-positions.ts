import type { Logger } from '@repo/evm-kit'
import type { PositionRecord } from '@repo/pipeline'
import type { Address, Hex } from 'viem'

import { createDeploylessClient } from '@repo/evm-kit'
import { tryCatch } from '@repo/utils'
import { getBlockNumber } from 'viem/actions'

import type { BorrowerCandidate } from '../borrowers'
import type { Env, UnhealthyPositionsConfig } from '../config'
import type { LensInput, LensOut } from '../lens.sol'
import type { ListedMarketsState } from '../markets'
import type { LiquidationPlan } from '../sizing/plan'

import { createApiCandidateSource, discoverBorrowers, MAX_DISCOVERY_PAGES } from '../borrowers'
import { loadUnhealthyPositionsConfig } from '../config'
import { LISTED_MARKETS_MAX_AGE_MS } from '../constants'
import { isLiquidatable, planInputFromLens } from '../eligibility'
import { expectedLoanOut } from '../execution/swap-step'
import { lensKey, readMidnightLiquidationLens } from '../lens.sol'
import { createListedMarketFilter } from '../markets'
import { formatPositionId } from '../position-id'
import { plan } from '../sizing/plan'

/** Prior `unhealthy-positions` cache: the market whitelist snapshot (with its `updatedAt` staleness signal). */
export type MidnightUnhealthyPositionsCache = ListedMarketsState

export type UnhealthyPositionsCounters = { pairs: number; liquidatable: number; emitted: number }

// Advisory-only sizing margin: the source op reports an indicative seize; `liquidate` re-sizes with the configured
// margin, so a 0 here (no headroom) is fine — the payload never gates a transaction.
const ADVISORY_SEIZE_CAP_MARGIN_BPS = 0

function short(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function positionRecord(
  chainId: number,
  id: Hex,
  borrower: Address,
  out: LensOut,
  liquidationPlan: LiquidationPlan,
  block: bigint
): PositionRecord {
  const collateral = out.market.collateralParams[liquidationPlan.collateralIndex]
  const repay = expectedLoanOut(liquidationPlan, out)
  const mode = liquidationPlan.postMaturityMode ? ' (post-maturity)' : ''
  return {
    kind: 'position',
    id: formatPositionId(chainId, id, borrower),
    chainId,
    marketId: id,
    borrower,
    summary: `midnight liq ${short(borrower)}${mode} — seize ${liquidationPlan.seizedAssets} for ~${repay} ${out.market.loanToken}`,
    loanToken: out.market.loanToken,
    collateralToken: collateral?.token ?? null,
    collateralIndex: liquidationPlan.collateralIndex,
    seizedAssets: liquidationPlan.seizedAssets.toString(),
    repaidUnits: liquidationPlan.repaidUnits.toString(),
    referenceRepay: repay.toString(),
    postMaturityMode: liquidationPlan.postMaturityMode,
    observedAtBlock: Number(block)
  }
}

/**
 * The read-only source core: enumerate the whitelist-filtered candidate universe, read the
 * liquidation lens fresh for the whole batch (one deployless `eth_call`), and emit one advisory
 * position record per liquidatable, plannable position. A transient discovery failure is
 * tolerated (`discover.error`, proceed with zero candidates). Deps are injected so the source is
 * unit-testable without a chain, a discovery endpoint, or config.
 */
export async function findUnhealthyPositions(deps: {
  chainId: number
  /** The Executor singleton — the `liquidate` msg.sender whose gate the lens checks. */
  caller: Address
  discover: () => Promise<BorrowerCandidate[]>
  chainHead: bigint
  readLens: (pairs: LensInput[]) => Promise<Map<string, LensOut>>
  emit: (record: PositionRecord) => void
  logger: Logger
}): Promise<UnhealthyPositionsCounters> {
  const { chainId, caller, discover, chainHead, readLens, emit, logger } = deps

  const { data: candidates, error: discoverError } = await tryCatch(discover())
  if (discoverError) logger.warn('discover.error', { error: discoverError.message })
  const pairs: LensInput[] = (candidates ?? []).map(candidate => ({
    id: candidate.marketId,
    borrower: candidate.borrower,
    caller
  }))

  const lensOut = await readLens(pairs)
  logger.info('lens.read', { pairs: pairs.length, returned: lensOut.size })

  let liquidatable = 0
  let emitted = 0
  for (const pair of pairs) {
    const out = lensOut.get(lensKey(pair.id, pair.borrower))
    if (!out || !isLiquidatable(out)) continue
    liquidatable += 1

    const liquidationPlan = plan(planInputFromLens(out), {
      seizeCapMarginBps: ADVISORY_SEIZE_CAP_MARGIN_BPS
    })
    if (!liquidationPlan) continue
    emitted += 1
    emit(positionRecord(chainId, pair.id, pair.borrower, out, liquidationPlan, chainHead))
  }

  logger.info('source.end', { pairs: pairs.length, liquidatable, emitted })
  return { pairs: pairs.length, liquidatable, emitted }
}

/**
 * One `unhealthy-positions` pass at the current chain head: build the read-only pipeline from `env`, restore and
 * refresh the market whitelist (fail-closed past its max age), run {@link findUnhealthyPositions} once, and return
 * the refreshed whitelist for the caller to persist. Never touches the filesystem, `process.stdout`,
 * or `Bun.env`. Loadable without any secret.
 *
 * `runStartupChecks` gates the boot-time startup log.
 */
export async function runUnhealthyPositions(
  env: Env,
  opts: {
    cache: MidnightUnhealthyPositionsCache | null
    runStartupChecks: boolean
    logger: Logger
    emit: (record: PositionRecord) => void
  }
): Promise<{ cache: MidnightUnhealthyPositionsCache }> {
  const config: UnhealthyPositionsConfig = loadUnhealthyPositionsConfig(env)
  const { logger, emit } = opts

  const client = createDeploylessClient(config)

  if (opts.runStartupChecks) {
    logger.info('startup', {
      chainId: config.chainId,
      midnight: config.midnight,
      caller: config.executooorAddress
    })
  }

  // Market whitelist, refreshed INLINE when stale. Transient failure keeps last-known-good; past the
  // fail-closed max-age the set is treated as EMPTY so a delisted market can never linger in scope on
  // the back of an old cache.
  const listedMarkets = createListedMarketFilter({
    apiUrl: config.markets.apiUrl,
    chainId: config.chainId,
    logger,
    ...(opts.cache ? { initialState: opts.cache } : {})
  })
  const whitelistAge = () => {
    const { updatedAt } = listedMarkets.snapshot()
    return updatedAt === null ? Infinity : Date.now() - updatedAt
  }
  if (whitelistAge() >= config.markets.refreshMs) {
    const { error } = await tryCatch(listedMarkets.refresh())
    if (error) logger.warn('markets.refresh_failed', { detail: error.message })
  }
  const whitelistExpired = whitelistAge() > LISTED_MARKETS_MAX_AGE_MS
  if (whitelistExpired) {
    logger.warn('markets.whitelist_expired', {
      ageMs: whitelistAge(),
      detail: 'whitelist older than max age — treating as empty (fail-closed) until a refresh lands'
    })
  }
  const isListed = (marketId: Hex) => !whitelistExpired && listedMarkets.isListed(marketId)

  const fetchPage = createApiCandidateSource({
    url: config.discovery.apiUrl,
    chainId: config.chainId,
    healthFactorLte: config.discovery.healthFactorLte
  })
  const discover = async () => {
    const candidates = await discoverBorrowers(fetchPage, { logger, maxPages: MAX_DISCOVERY_PAGES })
    const listed = candidates.filter(candidate => isListed(candidate.marketId))
    if (listed.length < candidates.length) {
      logger.info('discover.filtered', { total: candidates.length, listed: listed.length })
    }
    return listed
  }

  const head = await getBlockNumber(client)
  await findUnhealthyPositions({
    chainId: config.chainId,
    caller: config.executooorAddress,
    discover,
    chainHead: head,
    readLens: pairs => readMidnightLiquidationLens(client, config.midnight, pairs),
    emit,
    logger
  })

  return { cache: listedMarkets.dump() }
}
