import type { BackoffState, Logger, OutcomeRecord, TxRecord } from '@repo/bot-kit'
import type { QuoteOutcome, Swap, Venue, VenueSelectorState } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import {
  assertContractDeployed,
  createBackoff,
  createDeploylessClient,
  simulateLiquidationExec,
  WIRE_VERSION
} from '@repo/bot-kit'
import { createRateLimitedClient, createVenueSelector, priceByVenue } from '@repo/swaps'
import { erc20Abi } from 'viem'
import { getBlockNumber, readContract } from 'viem/actions'

import type { ActConfig, Env } from '../config'
import type { Market } from '../execution/encode-call'
import type { LiquidationPlan } from '../sizing/plan'
import type { LensInput, LensOut } from '../state/lens.sol'
import type { ParsedOpportunityId } from '../wire'

import { loadActConfig } from '../config'
import { encodeLiquidationExec } from '../execution/encode-call'
import { composeQuoting } from '../quotes'
import { isBadDebtRealization, plan } from '../sizing/plan'
import { lensKey, readMidnightLiquidationLens } from '../state/lens.sol'
import { isLiquidatable, planInputFromLens } from '../tick/eligibility'
import { DOMAIN, OP, parseOpportunityId } from '../wire'

/**
 * The narrowed `outcome.status` vocabulary `act` emits (bot-kit keeps `status` an open string). Each
 * value is a non-transient reason a candidate id yielded no tx; transient infra failures are stderr
 * logs plus exit 1, never outcomes.
 */
export type MidnightActStatus =
  | 'not_liquidatable'
  | 'no_swap_path'
  | 'quote_failed'
  | 'backoff_skipped'
  | 'sim_reverted'
  | 'skipped_inflight'
  | 'bad_id'

/** `act`'s disposable cache: the venue selector's per-pair ladder rankings + decimals. */
export type MidnightActCache = VenueSelectorState

export type ActCounters = {
  requested: number
  badId: number
  skippedInflight: number
  backoffSkipped: number
  notLiquidatable: number
  noSwapPath: number
  quoteFailed: number
  ok: number
  reverted: number
}

type Evaluand = ParsedOpportunityId & { id: string }

function outcomeRecord(
  id: string,
  chainId: number,
  status: MidnightActStatus,
  block: bigint,
  reason?: string
): OutcomeRecord {
  return {
    v: WIRE_VERSION,
    kind: 'outcome',
    id,
    domain: DOMAIN,
    op: OP,
    chainId,
    at: new Date().toISOString(),
    summary: `midnight liq ${status}${reason ? `: ${reason}` : ''}`,
    status,
    block: Number(block),
    ...(reason ? { reason } : {})
  }
}

function txRecord(
  id: string,
  chainId: number,
  to: Address,
  data: Hex,
  block: bigint,
  badDebt: boolean
): TxRecord {
  return {
    v: WIRE_VERSION,
    kind: 'tx',
    id,
    domain: DOMAIN,
    op: OP,
    chainId,
    at: new Date().toISOString(),
    summary: `midnight liq ${id}${badDebt ? ' — bad-debt realization' : ' — swap-funded'}`,
    to,
    data,
    simulated: { status: 'ok', block: Number(block) }
  }
}

/**
 * The actor core: map opportunity ids to freshly simulated tx records. For each id — parse (malformed
 * → `bad_id`), skip if in flight (`skipped_inflight`) or backed off (`backoff_skipped`), else
 * re-derive fresh (lens read → not liquidatable → `not_liquidatable`; plan → quote → encode →
 * simulate) and emit a `TxRecord` on sim-ok or an `outcome` otherwise. A pure bad-debt realization
 * needs no swap, so it skips quoting. Deps are injected so the actor is unit-testable without a chain,
 * an aggregator, or a signer.
 *
 * Backoff/inflight are consulted through the read-only `advisory` snapshot the caller supplies (the
 * queue owns recording/clearing); the snapshot is never mutated here.
 */
export async function runAct(deps: {
  ids: readonly string[]
  chainId: number
  head: bigint
  seizeCapMarginBps: number
  advisory: { backoff: BackoffState | null; inflightLabels: readonly string[] }
  backoffConfig: { baseBlocks: bigint; maxBlocks: bigint }
  readLensForIds: (evaluands: readonly Evaluand[]) => Promise<Map<string, LensOut>>
  quoteFor: (plan: LiquidationPlan, out: LensOut) => Promise<QuoteOutcome>
  simulate: (args: {
    market: Market
    borrower: Address
    plan: LiquidationPlan
    swap: Swap | null
  }) => Promise<string | null>
  encodeExec: (market: Market, borrower: Address, plan: LiquidationPlan, swap: Swap | null) => Hex
  executor: Address
  emit: (record: TxRecord | OutcomeRecord) => void
  logger: Logger
}): Promise<ActCounters> {
  const {
    ids,
    chainId,
    head,
    seizeCapMarginBps,
    advisory,
    backoffConfig,
    readLensForIds,
    quoteFor,
    simulate,
    encodeExec,
    executor,
    emit,
    logger
  } = deps

  const counters: ActCounters = {
    requested: ids.length,
    badId: 0,
    skippedInflight: 0,
    backoffSkipped: 0,
    notLiquidatable: 0,
    noSwapPath: 0,
    quoteFailed: 0,
    ok: 0,
    reverted: 0
  }

  // Read-only backoff: seeded from a COPY of the caller's snapshot (createBackoff copies entries on
  // restore) and only ever queried — the queue owns record/clear, so the snapshot stays untouched.
  const backoff = createBackoff({
    baseBlocks: backoffConfig.baseBlocks,
    maxBlocks: backoffConfig.maxBlocks,
    ...(advisory.backoff ? { initialState: advisory.backoff } : {})
  })
  const inflight = new Set(advisory.inflightLabels)

  const evaluands: Evaluand[] = []
  for (const id of ids) {
    const parsed = parseOpportunityId(id)
    if (!parsed || parsed.chainId !== chainId) {
      emit(outcomeRecord(id, chainId, 'bad_id', head))
      counters.badId += 1
      continue
    }
    if (inflight.has(id)) {
      emit(outcomeRecord(id, chainId, 'skipped_inflight', head))
      counters.skippedInflight += 1
      continue
    }
    if (backoff.shouldSkip(id, head)) {
      emit(outcomeRecord(id, chainId, 'backoff_skipped', head))
      counters.backoffSkipped += 1
      continue
    }
    evaluands.push({ id, ...parsed })
  }

  if (evaluands.length === 0) {
    logger.info('act.end', { ...counters })
    return counters
  }

  const lensOut = await readLensForIds(evaluands)

  for (const item of evaluands) {
    const out = lensOut.get(item.id)
    if (!out || !isLiquidatable(out)) {
      emit(outcomeRecord(item.id, chainId, 'not_liquidatable', head))
      counters.notLiquidatable += 1
      continue
    }
    const liquidationPlan = plan(planInputFromLens(out), { seizeCapMarginBps })
    if (!liquidationPlan) {
      emit(outcomeRecord(item.id, chainId, 'not_liquidatable', head, 'degenerate_plan'))
      counters.notLiquidatable += 1
      continue
    }

    // A pure bad-debt realization transfers no assets, so it skips quoting and runs as a no-callback
    // `liquidate`; every other plan needs a swap to fund the repay.
    let swap: Swap | null = null
    const badDebt = isBadDebtRealization(liquidationPlan)
    if (!badDebt) {
      const outcome = await quoteFor(liquidationPlan, out)
      if (outcome.kind === 'no_config') {
        emit(outcomeRecord(item.id, chainId, 'no_swap_path', head))
        counters.noSwapPath += 1
        continue
      }
      if (outcome.kind === 'failed') {
        emit(outcomeRecord(item.id, chainId, 'quote_failed', head, outcome.reason))
        counters.quoteFailed += 1
        continue
      }
      swap = outcome.swap
    }

    const revert = await simulate({
      market: out.market,
      borrower: item.borrower,
      plan: liquidationPlan,
      swap
    })
    if (revert !== null) {
      emit(outcomeRecord(item.id, chainId, 'sim_reverted', head, revert))
      counters.reverted += 1
      continue
    }
    const data = encodeExec(out.market, item.borrower, liquidationPlan, swap)
    emit(txRecord(item.id, chainId, executor, data, head, badDebt))
    counters.ok += 1
  }

  logger.info('act.end', { ...counters })
  return counters
}

/**
 * One `act` pass at the current chain head: build the multi-venue quote → simulate pipeline from
 * `env`, run {@link runAct} over `ids`, and return the refreshed venue-selector cache for the caller
 * to persist. Needs venue API keys — read from the env table at the point of use, never stored — but
 * NOT the signer private key. Never touches the filesystem, `process.stdout`, or `Bun.env`.
 *
 * `runStartupChecks` gates the boot-time Executor-code + venue diagnostics.
 */
export async function actOnce(
  env: Env,
  ids: readonly string[],
  opts: {
    cache: MidnightActCache | null
    advisory: { backoff: BackoffState | null; inflightLabels: readonly string[] }
    runStartupChecks: boolean
    logger: Logger
    emit: (record: TxRecord | OutcomeRecord) => void
  }
): Promise<{ cache: MidnightActCache }> {
  const config: ActConfig = loadActConfig(env)
  const { logger, emit } = opts

  const client = createDeploylessClient(config)

  if (opts.runStartupChecks) {
    await assertContractDeployed(
      client,
      config.executooorAddress,
      'EXECUTOOOR_ADDRESS',
      'deploy it with `bun run --filter @repo/contracts deploy:executor`'
    )
  }

  const apiKeys: Partial<Record<Venue, string>> = {}
  if (env.ZEROX_API_KEY) apiKeys['0x'] = env.ZEROX_API_KEY
  if (env.ONEINCH_API_KEY) apiKeys['1inch'] = env.ONEINCH_API_KEY
  const venues = config.venues.enabled
  if (opts.runStartupChecks) {
    if (venues.length === 0) {
      logger.warn('venues.none_enabled', {
        chainId: config.chainId,
        detail:
          'no venue API keys set — running bad-debt-only (positions discovered, bad debt realized, no swap-liquidations)'
      })
    } else {
      logger.info('quoting.startup', { chainId: config.chainId, venues })
    }
  }
  const baseUrls: Partial<Record<Venue, string>> = {}
  if (config.venues.zeroxBaseUrl) baseUrls['0x'] = config.venues.zeroxBaseUrl
  if (config.venues.oneinchBaseUrl) baseUrls['1inch'] = config.venues.oneinchBaseUrl

  // Two rate-limited HTTP clients: one for time-sensitive FIRM quotes, a slower one for BACKGROUND
  // probes — so a probe burst can never queue ahead of a live liquidation's firm quote.
  const httpClient = createRateLimitedClient({
    apiKeys,
    rps: config.quoting.httpRps,
    burst: config.quoting.httpBurst,
    maxRetries: config.quoting.httpMaxRetries,
    timeoutMs: config.quoting.quoteTimeoutMs
  })
  const probeClient = createRateLimitedClient({
    apiKeys,
    rps: config.probe.httpRps,
    burst: config.probe.httpRps,
    maxRetries: config.quoting.httpMaxRetries,
    timeoutMs: config.quoting.quoteTimeoutMs
  })

  const venueSelector = createVenueSelector({
    venues,
    chainId: config.chainId,
    ladderWholeTokens: config.probe.ladderWholeTokens,
    getDecimals: token =>
      readContract(client, { address: token, abi: erc20Abi, functionName: 'decimals' }),
    indicativeQuote: (venue, params) => priceByVenue(probeClient, { venue, baseUrls, params }),
    staleMs: config.probe.staleMs,
    logger,
    ...(opts.cache ? { initialState: opts.cache } : {})
  })

  const { quoteFor } = composeQuoting({
    httpClient,
    selector: venueSelector,
    chainId: config.chainId,
    executor: config.executooorAddress,
    venues,
    slippageBps: config.venues.slippageBps,
    baseUrls,
    maxRouteImpactBps: config.quoting.maxRouteImpactBps,
    excludeCollaterals: config.venues.excludeCollaterals,
    logger
  })

  // The operator EOA: the skim `recipient` in the exec calldata AND the simulate `from`, so the
  // simulated bytes match the exact broadcast context the queue signs. Never the Executor — it is
  // ownerless, and skimming seized funds there strands them where anyone can take them.
  const eoa = config.liquidatorAddress
  const encodeExec = (
    market: Market,
    borrower: Address,
    p: LiquidationPlan,
    swap: Swap | null
  ): Hex =>
    encodeLiquidationExec({
      executor: config.executooorAddress,
      midnight: config.midnight,
      market,
      collateralIndex: p.collateralIndex,
      seizedAssets: p.seizedAssets,
      repaidUnits: p.repaidUnits,
      borrower,
      postMaturityMode: p.postMaturityMode,
      swap,
      recipient: eoa
    })

  const readLensForIds = async (evaluands: readonly Evaluand[]): Promise<Map<string, LensOut>> => {
    const inputs: LensInput[] = evaluands.map(e => ({
      id: e.marketId,
      borrower: e.borrower,
      caller: config.executooorAddress
    }))
    const byLensKey = await readMidnightLiquidationLens(client, config.midnight, inputs)
    const byWireId = new Map<string, LensOut>()
    for (const e of evaluands) {
      const out = byLensKey.get(lensKey(e.marketId, e.borrower))
      if (out) byWireId.set(e.id, out)
    }
    return byWireId
  }

  const head = await getBlockNumber(client)
  await runAct({
    ids,
    chainId: config.chainId,
    head,
    seizeCapMarginBps: config.quoting.seizeCapMarginBps,
    advisory: opts.advisory,
    backoffConfig: {
      baseBlocks: config.quoting.backoffBaseBlocks,
      maxBlocks: config.quoting.backoffMaxBlocks
    },
    readLensForIds,
    quoteFor,
    simulate: async ({ market, borrower, plan: p, swap }) => {
      const result = await simulateLiquidationExec(client, {
        executooor: config.executooorAddress,
        eoa,
        data: encodeExec(market, borrower, p, swap)
      })
      return result.status === 'ok' ? null : (result.reason ?? 'revert')
    },
    encodeExec,
    executor: config.executooorAddress,
    emit,
    logger
  })

  return { cache: venueSelector.dump() }
}
