import type { Logger } from '@repo/evm-kit'
import type { PositionRecord } from '@repo/pipeline'
import type { Address, Hex } from 'viem'

import { assertContractDeployed, createDeploylessClient } from '@repo/evm-kit'
import { ensureError, tryCatch } from '@repo/utils'
import { getBlockNumber } from 'viem/actions'

import type { BorrowerCandidate } from '../borrowers'
import type { Env, UnhealthyPositionsConfig } from '../config'
import type { LensInput, LensOut } from '../lens.sol'
import type { MarketParamsCache } from '../market-params'
import type { LiquidationPlan } from '../sizing/plan'

import {
  createPostgresQuery,
  discoverCandidates,
  discoveryDiagnostics,
  rindexerSyncedBlock
} from '../borrowers'
import { loadUnhealthyPositionsConfig } from '../config'
import { isLiquidatable, planInputFromLens } from '../eligibility'
import { expectedLoanOut } from '../execution/swap-step'
import { lensKey, readBlueLiquidationLens } from '../lens.sol'
import { marketId } from '../market'
import { createMarketParamsResolver, multicallIdToMarketParams } from '../market-params'
import { formatPositionId } from '../position-id'
import { plan } from '../sizing/plan'

/** Prior `unhealthy-positions` cache: the resolver's `MarketParams` entries. Immutable per id, safe forever. */
export type BlueUnhealthyPositionsCache = MarketParamsCache

export type UnhealthyPositionsCounters = { pairs: number; liquidatable: number; emitted: number }

/** Blocks our rindexer may trail the chain head before we warn that coverage is degraded. */
const MAX_RINDEXER_LAG_BLOCKS = 30n

function short(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

// Builds a transparent position record. Identity fields drive the next stage; sizing fields remain
// advisory because `liquidate` re-reads mutable state.
function positionRecord(
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
    id: formatPositionId(chainId, id, borrower),
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
 * The read-only source core: log a rindexer-freshness signal, enumerate the indexed
 * (market, borrower) universe, read the liquidation lens fresh for the whole batch (one deployless
 * `eth_call`), and emit one position record per liquidatable, plannable position. Deps
 * are injected so the source is unit-testable without a chain, Postgres, or config. Emits nothing
 * but position records — lockless and secret-free.
 */
export async function findUnhealthyPositions(deps: {
  chainId: number
  discover: () => Promise<BorrowerCandidate[]>
  /** rindexer's indexed head (Postgres); `null`/throw → lag unknown, we proceed. */
  syncedBlock: () => Promise<bigint | null>
  /** Chain head the caller just polled — lag reference + the position's observed block. */
  chainHead: bigint
  readLens: (pairs: LensInput[]) => Promise<Map<string, LensOut>>
  emit: (record: PositionRecord) => void
  logger: Logger
}): Promise<UnhealthyPositionsCounters> {
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
    if (!out || !isLiquidatable(out)) {
      // Per-position trail so "why wasn't X emitted" is answerable downstream; DEBUG because a full
      // candidate set is mostly healthy (hundreds/tick), invisible at the default `info` level.
      logger.debug('source.skip', {
        id: formatPositionId(chainId, id, pair.borrower),
        status: 'not_liquidatable',
        block: chainHead
      })
      continue
    }
    liquidatable += 1

    // Plan off-chain (pure, no RPC) to size the advisory payload; a degenerate (collateral-less)
    // position has no plan and is not actionable, so the source does not emit it — rare, so INFO.
    const liquidationPlan = plan(planInputFromLens(out))
    if (!liquidationPlan) {
      logger.info('source.skip', {
        id: formatPositionId(chainId, id, pair.borrower),
        status: 'not_liquidatable',
        reason: 'degenerate_plan',
        block: chainHead
      })
      continue
    }
    emitted += 1
    emit(positionRecord(chainId, id, pair.borrower, out, liquidationPlan, chainHead))
  }

  logger.info('source.end', { pairs: pairs.length, liquidatable, emitted })
  return { pairs: pairs.length, liquidatable, emitted }
}

/**
 * One `unhealthy-positions` pass at the current chain head: build the read-only pipeline from `env`, restore the
 * marketParams cache, run {@link findUnhealthyPositions} once, and return the refreshed cache for the caller to
 * persist. Never touches the filesystem, `process.stdout`, or `Bun.env` — records ride `emit`, logs
 * ride `logger`, config comes from the env table. Loadable without any secret.
 *
 * `runStartupChecks` gates the boot-time diagnostics (Morpho code + the rindexer discovery
 * self-check) so they run on a fresh host rather than every ~2s spawn.
 */
export async function runUnhealthyPositions(
  env: Env,
  opts: {
    cache: BlueUnhealthyPositionsCache | null
    runStartupChecks: boolean
    logger: Logger
    emit: (record: PositionRecord) => void
  }
): Promise<{ cache: BlueUnhealthyPositionsCache }> {
  const config: UnhealthyPositionsConfig = loadUnhealthyPositionsConfig(env)
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
  await findUnhealthyPositions({
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
