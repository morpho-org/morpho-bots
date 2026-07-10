import type { BackoffState, Logger, OutcomeRecord, TxRecord } from '@repo/bot-kit'
import type { QuoteOutcome, Swap, SwapConfigEntry, Venue } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import {
  assertContractDeployed,
  createBackoff,
  createDeploylessClient,
  simulateLiquidationExec,
  WIRE_VERSION
} from '@repo/bot-kit'
import { createRateLimitedClient } from '@repo/swaps'
import { getAddress } from 'viem'
import { getBlockNumber } from 'viem/actions'

import type { ActConfig, Env } from '../config'
import type { MarketParams } from '../market'
import type { LiquidationPlan } from '../sizing/plan'
import type { LensInput, LensOut } from '../state/lens.sol'
import type { ParsedOpportunityId } from '../wire'

import { loadActConfig } from '../config'
import { encodeLiquidationExec } from '../execution/encode-call'
import { composeQuoting } from '../quotes'
import { plan } from '../sizing/plan'
import { lensKey, readBlueLiquidationLens } from '../state/lens.sol'
import { createMarketParamsResolver, multicallIdToMarketParams } from '../state/market-params'
import { isLiquidatable, planInputFromLens } from '../tick/eligibility'
import { DOMAIN, OP, parseOpportunityId } from '../wire'

/**
 * The narrowed `outcome.status` vocabulary `act` emits (bot-kit keeps `status` an open string). Each
 * value is a non-transient reason a candidate id yielded no tx; transient infra failures are stderr
 * logs plus exit 1, never outcomes.
 */
export type BlueActStatus =
  | 'not_liquidatable'
  | 'no_swap_path'
  | 'quote_failed'
  | 'backoff_skipped'
  | 'sim_reverted'
  | 'skipped_inflight'
  | 'bad_id'

/** `act` holds no cross-tick cache — it re-derives everything fresh — so its cache is trivially empty. */
export type BlueActCache = Record<string, never>

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
  status: BlueActStatus,
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
    summary: `blue liq ${status}${reason ? `: ${reason}` : ''}`,
    status,
    block: Number(block),
    ...(reason ? { reason } : {})
  }
}

function txRecord(id: string, chainId: number, to: Address, data: Hex, block: bigint): TxRecord {
  return {
    v: WIRE_VERSION,
    kind: 'tx',
    id,
    domain: DOMAIN,
    op: OP,
    chainId,
    at: new Date().toISOString(),
    summary: `blue liq ${id} — repay via configured swap`,
    to,
    data,
    simulated: { status: 'ok', block: Number(block) }
  }
}

/**
 * The actor core: map opportunity ids to freshly simulated tx records. For each id — parse (malformed
 * → `bad_id`), skip if in flight (`skipped_inflight`) or backed off (`backoff_skipped`), else
 * re-derive fresh (lens read → not liquidatable → `not_liquidatable`; plan → quote → encode →
 * simulate) and emit a `TxRecord` on sim-ok or an `outcome` otherwise. Deps are injected so the actor
 * is unit-testable without a chain, an aggregator, or a signer.
 *
 * Backoff/inflight are consulted through the read-only `advisory` snapshot the caller supplies (the
 * queue owns recording/clearing); the snapshot is never mutated here.
 */
export async function runAct(deps: {
  ids: readonly string[]
  chainId: number
  head: bigint
  advisory: { backoff: BackoffState | null; inflightLabels: readonly string[] }
  backoffConfig: { baseBlocks: bigint; maxBlocks: bigint }
  readLensForIds: (evaluands: readonly Evaluand[]) => Promise<Map<string, LensOut>>
  quoteFor: (plan: LiquidationPlan, out: LensOut) => Promise<QuoteOutcome>
  simulate: (args: {
    market: MarketParams
    borrower: Address
    plan: LiquidationPlan
    swap: Swap
  }) => Promise<string | null>
  encodeExec: (market: MarketParams, borrower: Address, plan: LiquidationPlan, swap: Swap) => Hex
  executor: Address
  emit: (record: TxRecord | OutcomeRecord) => void
  logger: Logger
}): Promise<ActCounters> {
  const {
    ids,
    chainId,
    head,
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

  // One batched lens read (blue resolves marketParams itself, fresh) for every non-skipped id.
  const lensOut = await readLensForIds(evaluands)

  for (const item of evaluands) {
    const out = lensOut.get(item.id)
    if (!out || !isLiquidatable(out)) {
      emit(outcomeRecord(item.id, chainId, 'not_liquidatable', head))
      counters.notLiquidatable += 1
      continue
    }
    const liquidationPlan = plan(planInputFromLens(out))
    if (!liquidationPlan) {
      emit(outcomeRecord(item.id, chainId, 'not_liquidatable', head, 'degenerate_plan'))
      counters.notLiquidatable += 1
      continue
    }
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
    const swap = outcome.swap

    const revert = await simulate({
      market: out.params,
      borrower: item.borrower,
      plan: liquidationPlan,
      swap
    })
    if (revert !== null) {
      emit(outcomeRecord(item.id, chainId, 'sim_reverted', head, revert))
      counters.reverted += 1
      continue
    }
    const data = encodeExec(out.params, item.borrower, liquidationPlan, swap)
    emit(txRecord(item.id, chainId, executor, data, head))
    counters.ok += 1
  }

  logger.info('act.end', { ...counters })
  return counters
}

/**
 * One `act` pass at the current chain head: build the quote → simulate pipeline from `env`, run
 * {@link runAct} over `ids`, and return the (empty) act cache. Needs venue API keys — read from the
 * env table at the point of use, never stored — but NOT the signer private key. Never touches the
 * filesystem, `process.stdout`, or `Bun.env`.
 *
 * `runStartupChecks` gates the boot-time Executor-code + swap-route diagnostics.
 */
export async function actOnce(
  env: Env,
  ids: readonly string[],
  opts: {
    cache: BlueActCache | null
    advisory: { backoff: BackoffState | null; inflightLabels: readonly string[] }
    runStartupChecks: boolean
    logger: Logger
    emit: (record: TxRecord | OutcomeRecord) => void
  }
): Promise<{ cache: BlueActCache }> {
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

  // Per-collateral swap routing for this chain, keyed by EIP-55-checksummed collateral address.
  const swapByCollateral = new Map<string, SwapConfigEntry>()
  for (const [token, entry] of Object.entries(config.swapConfig[String(config.chainId)] ?? {})) {
    if (entry) swapByCollateral.set(getAddress(token), entry)
  }
  if (opts.runStartupChecks) {
    if (swapByCollateral.size === 0) {
      logger.warn('swap_config.no_routes', {
        chainId: config.chainId,
        detail:
          'no swap routes configured — every liquidation will be skipped (config.no_swap_path)'
      })
    } else {
      logger.info('quoting.startup', {
        chainId: config.chainId,
        venues: Object.fromEntries(
          [...swapByCollateral].map(([token, entry]) => [token, entry.venue])
        )
      })
    }
  }

  // Venue API keys come from the env TABLE (point of use), so file-sourced secrets work; they stay
  // in this closure and are never stored on the logged Config.
  const apiKeys: Partial<Record<Venue, string>> = {}
  if (env.ZEROX_API_KEY) apiKeys['0x'] = env.ZEROX_API_KEY
  if (env.ONEINCH_API_KEY) apiKeys['1inch'] = env.ONEINCH_API_KEY
  const httpClient = createRateLimitedClient({
    apiKeys,
    rps: config.quoting.httpRps,
    burst: config.quoting.httpBurst,
    maxRetries: config.quoting.httpMaxRetries,
    timeoutMs: config.quoting.quoteTimeoutMs
  })
  const { quoteFor } = composeQuoting({
    httpClient,
    chainId: config.chainId,
    executor: config.executooorAddress,
    swapByCollateral,
    maxRouteImpactBps: config.quoting.maxRouteImpactBps,
    logger
  })

  // The operator EOA: the skim `recipient` in the exec calldata AND the simulate `from`, so the
  // simulated bytes match the exact broadcast context the queue signs. Never the Executor — it is
  // ownerless, and skimming seized funds there strands them where anyone can take them.
  const eoa = config.liquidatorAddress
  const encodeExec = (
    market: MarketParams,
    borrower: Address,
    p: LiquidationPlan,
    swap: Swap
  ): Hex =>
    encodeLiquidationExec({
      executor: config.executooorAddress,
      morpho: config.morpho,
      market,
      seizedAssets: p.seizedAssets,
      borrower,
      swap,
      recipient: eoa
    })

  // Fresh, uncached resolver — one batched multicall per act pass is cheap, and act keeps no cache.
  const resolveParams = createMarketParamsResolver(multicallIdToMarketParams(client, config.morpho))
  const readLensForIds = async (evaluands: readonly Evaluand[]): Promise<Map<string, LensOut>> => {
    const paramsById = await resolveParams(evaluands.map(e => e.marketId))
    const inputs: LensInput[] = []
    const idByLensKey = new Map<string, string>()
    for (const e of evaluands) {
      const params = paramsById.get(e.marketId)
      if (!params) continue // unresolved market → absent from the map → `not_liquidatable`
      inputs.push({ params, borrower: e.borrower })
      idByLensKey.set(lensKey(e.marketId, e.borrower), e.id)
    }
    const byLensKey = await readBlueLiquidationLens(client, config.morpho, inputs)
    const byWireId = new Map<string, LensOut>()
    for (const [lk, o] of byLensKey) {
      const wireId = idByLensKey.get(lk)
      if (wireId) byWireId.set(wireId, o)
    }
    return byWireId
  }

  const head = await getBlockNumber(client)
  await runAct({
    ids,
    chainId: config.chainId,
    head,
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

  return { cache: {} }
}
