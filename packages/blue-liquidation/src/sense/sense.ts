import type { Logger, PositionRecord } from '@repo/bot-kit'
import type { Address, Hex } from 'viem'

import { assertContractDeployed, createDeploylessClient } from '@repo/bot-kit'
import { ensureError, tryCatch } from '@repo/utils'
import { getBlockNumber } from 'viem/actions'

import type { Env, SenseConfig } from '../config'
import type { BorrowerCandidate } from '../discovery/borrowers'
import type { LiquidationPlan } from '../sizing/plan'
import type { LensInput, LensOut } from '../state/lens.sol'
import type { MarketParamsCache } from '../state/market-params'

import { loadSenseConfig } from '../config'
import {
  createPostgresQuery,
  discoverCandidates,
  discoveryDiagnostics,
  rindexerSyncedBlock
} from '../discovery/borrowers'
import { expectedLoanOut } from '../execution/swap-step'
import { marketId } from '../market'
import { plan } from '../sizing/plan'
import { lensKey, readBlueLiquidationLens } from '../state/lens.sol'
import { createMarketParamsResolver, multicallIdToMarketParams } from '../state/market-params'
import { isLiquidatable, planInputFromLens } from '../tick/eligibility'
import { formatOpportunityId } from '../wire'

/** Prior `sense` cache: the resolver's `MarketParams` entries. Immutable per id, safe forever. */
export type BlueSenseCache = MarketParamsCache

export type SenseCounters = { pairs: number; liquidatable: number; emitted: number }

/** Blocks our rindexer may trail the chain head before we warn that coverage is degraded. */
const MAX_RINDEXER_LAG_BLOCKS = 30n

function short(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

// Builds a transparent position record. Identity fields drive the next stage; sizing fields remain
// advisory because `liquidate` re-reads mutable state.
function opportunityRecord(
  chainId: number,
  id: Hex,
  borrower: Address,
  out: LensOut,
  liquidationPlan: LiquidationPlan,
  block: bigint
): PositionRecord {
  const repay = expectedLoanOut(liquidationPlan, out)
  return {
    kind: 'position',
    id: formatOpportunityId(chainId, id, borrower),
    chainId,
    marketId: id,
    borrower,
    market: { ...out.params, lltv: out.params.lltv.toString() },
    seizableCollateral: liquidationPlan.seizedAssets.toString(),
    repayAssets: repay.toString(),
    observedAtBlock: Number(block),
    summary: `blue liq ${short(borrower)} — seize ${liquidationPlan.seizedAssets} ${out.params.collateralToken} for ~${repay} ${out.params.loanToken}`
  }
}

/**
 * The read-only sensor core: log a rindexer-freshness signal, enumerate the indexed
 * (market, borrower) universe, read the liquidation lens fresh for the whole batch (one deployless
 * `eth_call`), and emit one position record per liquidatable, plannable position. Deps
 * are injected so the sensor is unit-testable without a chain, Postgres, or config. Emits nothing but
 * opportunities — lockless and secret-free.
 */
export async function runSense(deps: {
  chainId: number
  discover: () => Promise<BorrowerCandidate[]>
  /** rindexer's indexed head (Postgres); `null`/throw → lag unknown, we proceed. */
  syncedBlock: () => Promise<bigint | null>
  /** Chain head the runner just polled — lag reference + the opportunity's `data.block`. */
  chainHead: bigint
  readLens: (pairs: LensInput[]) => Promise<Map<string, LensOut>>
  emit: (record: PositionRecord) => void
  logger: Logger
}): Promise<SenseCounters> {
  const { chainId, discover, syncedBlock, chainHead, readLens, emit, logger } = deps

  // rindexer-freshness signal — observability only; the lens reads every candidate fresh on-chain, so
  // lag is coverage latency, never a correctness issue. `tryCatch` + `null` both mean "lag unknown".
  const { data: synced } = await tryCatch(syncedBlock())
  if (synced === null) {
    logger.warn('rindexer.lag', { reason: 'unknown', chainHead })
  } else {
    const lag = chainHead > synced ? chainHead - synced : 0n
    if (lag > MAX_RINDEXER_LAG_BLOCKS) logger.warn('rindexer.lag', { chainHead, synced, lag })
    else logger.debug('rindexer.lag', { chainHead, synced, lag })
  }

  const candidates = await discover()
  const pairs: LensInput[] = candidates.map(candidate => ({
    params: candidate.marketParams,
    borrower: candidate.borrower
  }))

  const lensOut = await readLens(pairs)
  logger.info('lens.read', { pairs: pairs.length, returned: lensOut.size })

  let liquidatable = 0
  let emitted = 0
  for (const pair of pairs) {
    const id = marketId(pair.params)
    const out = lensOut.get(lensKey(id, pair.borrower))
    if (!out || !isLiquidatable(out)) continue
    liquidatable += 1

    // Plan off-chain (pure, no RPC) to size the advisory payload; a degenerate (collateral-less)
    // position yields no plan and is not an actionable opportunity, so it is sensed but not emitted.
    const liquidationPlan = plan(planInputFromLens(out))
    if (!liquidationPlan) continue
    emitted += 1
    emit(opportunityRecord(chainId, id, pair.borrower, out, liquidationPlan, chainHead))
  }

  logger.info('sense.end', { pairs: pairs.length, liquidatable, emitted })
  return { pairs: pairs.length, liquidatable, emitted }
}

/**
 * One `sense` pass at the current chain head: build the read-only pipeline from `env`, restore the
 * marketParams cache, run {@link runSense} once, and return the refreshed cache for the caller to
 * persist. Never touches the filesystem, `process.stdout`, or `Bun.env` — records ride `emit`, logs
 * ride `logger`, config comes from the env table. Loadable without any secret.
 *
 * `runStartupChecks` gates the boot-time diagnostics (Morpho code + the rindexer discovery
 * self-check) so they run on a fresh host rather than every ~2s spawn.
 */
export async function senseOnce(
  env: Env,
  opts: {
    cache: BlueSenseCache | null
    runStartupChecks: boolean
    logger: Logger
    emit: (record: PositionRecord) => void
  }
): Promise<{ cache: BlueSenseCache }> {
  const config: SenseConfig = loadSenseConfig(env)
  const { logger, emit } = opts

  const client = createDeploylessClient(config)
  const query = createPostgresQuery(config.databaseUrl)

  const resolveParams = createMarketParamsResolver(
    multicallIdToMarketParams(client, config.morpho),
    opts.cache ?? undefined
  )
  const discover = () => discoverCandidates(query, resolveParams, config.network)

  if (opts.runStartupChecks) {
    logger.info('startup', {
      chainId: config.chainId,
      network: config.network,
      morpho: config.morpho
    })
    await assertContractDeployed(client, config.morpho, 'Morpho singleton')
    // Non-fatal discovery self-check: surface the rindexer schema + first result so a column-name
    // mismatch or a not-yet-migrated table is diagnosable from logs on a fresh host.
    const diag = await tryCatch(discoveryDiagnostics(query))
    if (diag.error) {
      logger.warn('discovery.startup_error', { detail: ensureError(diag.error).message })
    } else {
      logger.info('discovery.schema', { network: config.network, borrow: diag.data.borrow })
      const probe = await tryCatch(
        Promise.all([discover(), rindexerSyncedBlock(query, config.network)])
      )
      if (probe.error) {
        logger.warn('discovery.startup_error', { detail: ensureError(probe.error).message })
      } else {
        const [candidates, syncedBlock] = probe.data
        logger.info('discovery.startup', {
          network: config.network,
          candidates: candidates.length,
          syncedBlock,
          sample: candidates[0] ?? null
        })
      }
    }
  }

  const head = await getBlockNumber(client)
  await runSense({
    chainId: config.chainId,
    discover,
    syncedBlock: () => rindexerSyncedBlock(query, config.network),
    chainHead: head,
    readLens: pairs => readBlueLiquidationLens(client, config.morpho, pairs),
    emit,
    logger
  })

  return { cache: resolveParams.dump() }
}
