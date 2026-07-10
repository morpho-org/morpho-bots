import type {
  BackoffState,
  Logger,
  OutcomeRecord,
  PendingQueueState,
  TxRecord
} from '@repo/bot-kit'
import type { Swap, SwapConfigEntry, Venue } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import {
  assertContractDeployed,
  createBackoff,
  createDeploylessClient,
  createLogger,
  createPendingQueue,
  createSigner,
  initialFees,
  simulateLiquidationExec
} from '@repo/bot-kit'
import { createRateLimitedClient } from '@repo/swaps'
import { ensureError, tryCatch } from '@repo/utils'
import { getAddress } from 'viem'
import { getBlockNumber } from 'viem/actions'

import type { BlueActStatus, BlueActCache } from './act/act'
import type { Env } from './config'
import type { MarketParams } from './market'
import type { BlueSenseCache } from './sense/sense'
import type { LiquidationPlan } from './sizing/plan'
import type { LensInput, LensOut } from './state/lens.sol'
import type { MarketParamsCache } from './state/market-params'

import { runAct } from './act/act'
import { loadConfig } from './config'
import {
  createPostgresQuery,
  discoverCandidates,
  discoveryDiagnostics,
  rindexerSyncedBlock
} from './discovery/borrowers'
import { encodeLiquidationExec } from './execution/encode-call'
import { composeQuoting } from './quotes'
import { runSense } from './sense/sense'
import { lensKey, readBlueLiquidationLens } from './state/lens.sol'
import { createMarketParamsResolver, multicallIdToMarketParams } from './state/market-params'

export type { Config, Env, SenseConfig, ActConfig } from './config'
export { loadConfig, loadSenseConfig, loadActConfig } from './config'
export { DOMAIN, formatOpportunityId, parseOpportunityId } from './wire'
export type { ParsedOpportunityId } from './wire'
export { runSense, senseOnce } from './sense/sense'
export type { BlueSenseCache, SenseCounters } from './sense/sense'
export { runAct, actOnce } from './act/act'
export type { BlueActStatus, BlueActCache, ActCounters } from './act/act'

/** Bumped when the persisted-state shape or its label format changes; a mismatched file is discarded,
 * not migrated. v2: labels/ids are now the `blue:liq:…` wire id, not the old `${id}:${borrower}`. */
export const STATE_VERSION = 2

/** Bumped when a stage's disposable cache shape changes; a mismatched cache is rebuilt, not migrated. */
export const SENSE_CACHE_VERSION = 1
export const ACT_CACHE_VERSION = 1

/** Counters `tickOnce` reports for one full cycle (sense + act + submit). */
export type TickCounters = {
  pairs: number
  liquidatable: number
  planned: number
  noSwapPath: number
  quoteFailed: number
  backoffSkipped: number
  ok: number
  reverted: number
  submitted: number
}

/**
 * Everything one tick hands to the next across a process boundary. A HINT, not truth: the queue
 * section is reconciled against receipts on the next tick's `onBlock`, and a lost/corrupt file
 * degrades to today's restart semantics (chain truth wins).
 */
export type BluePersistedState = {
  version: number
  queue: PendingQueueState
  backoff: BackoffState
  marketParams: MarketParamsCache
}

/**
 * @deprecated One-shot composition of the split stages, kept only so the CLI's `tick` command and its
 * spawn tests stay green through the pipeline migration. Deleted in the next PR once the CLI wires
 * `sense`/`act`/`queue` directly. New callers use {@link senseOnce} / {@link actOnce}.
 *
 * Runs the pipeline once at the current head: sense → collect emitted ids → act → submit the emitted
 * tx records via the queue → `onBlock`. Preserves the pre-split signature and persisted-state shape.
 * Everything is keyed by the `blue:liq:…` wire id (backoff, inflight, queue labels), and the
 * {@link STATE_VERSION} bump discards any old `${id}:${borrower}`-keyed file cleanly. All env —
 * including venue API keys — is read from the `env` table, never `Bun.env`.
 */
export async function tickOnce(
  env: Env,
  opts: { state?: BluePersistedState; runStartupChecks?: boolean; logger?: Logger } = {}
): Promise<{ counters: TickCounters; state: BluePersistedState }> {
  const config = loadConfig(env)
  const logger = opts.logger ?? createLogger(config.logLevel)
  const state = opts.state?.version === STATE_VERSION ? opts.state : undefined

  const signer = createSigner({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback,
    privateKey: config.liquidatorPrivateKey
  })
  const eoa = signer.account.address

  const client = createDeploylessClient(config)
  const query = createPostgresQuery(config.databaseUrl)

  if (opts.runStartupChecks) {
    logger.info('startup', {
      chainId: config.chainId,
      network: config.network,
      liquidator: eoa,
      callback: config.executooorAddress,
      morpho: config.morpho
    })
    await assertContractDeployed(
      client,
      config.executooorAddress,
      'EXECUTOOOR_ADDRESS',
      'deploy it with `bun run --filter @repo/contracts deploy:executor`'
    )
    await assertContractDeployed(client, config.morpho, 'Morpho singleton')
  }

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
  const backoff = createBackoff({
    baseBlocks: config.quoting.backoffBaseBlocks,
    maxBlocks: config.quoting.backoffMaxBlocks,
    ...(state ? { initialState: state.backoff } : {})
  })

  const encodeExec = (
    market: MarketParams,
    borrower: Address,
    liquidationPlan: LiquidationPlan,
    swap: Swap
  ): Hex =>
    encodeLiquidationExec({
      executor: config.executooorAddress,
      morpho: config.morpho,
      market,
      seizedAssets: liquidationPlan.seizedAssets,
      borrower,
      swap,
      recipient: eoa
    })

  const resolveParams = createMarketParamsResolver(
    multicallIdToMarketParams(client, config.morpho),
    state?.marketParams
  )
  const discover = () => discoverCandidates(query, resolveParams, config.network)

  if (opts.runStartupChecks) {
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

  const queue = createPendingQueue({
    send: signer.send,
    getReceipt: signer.getReceipt,
    getBaseFee: signer.getBaseFee,
    syncNonce: signer.syncNonce,
    maxFeeWei: config.maxFeeWei,
    logger,
    ...(state ? { initialState: state.queue } : {})
  })

  const head = await getBlockNumber(client)

  // 1. Sense — collect the emitted wire ids.
  const ids: string[] = []
  const senseCounters = await runSense({
    chainId: config.chainId,
    discover,
    syncedBlock: () => rindexerSyncedBlock(query, config.network),
    chainHead: head,
    readLens: pairs => readBlueLiquidationLens(client, config.morpho, pairs),
    emit: record => ids.push(record.id),
    logger
  })

  // 2. Act — re-derive each id and collect tx records; map failure outcomes onto backoff (the role
  //    the queue command will own once the CLI lands). The `resolveParams` cache is warm from sense.
  const readLensForIds = async (
    evaluands: readonly { id: string; marketId: Hex; borrower: Address }[]
  ): Promise<Map<string, LensOut>> => {
    const paramsById = await resolveParams(evaluands.map(e => e.marketId))
    const inputs: LensInput[] = []
    const idByLensKey = new Map<string, string>()
    for (const e of evaluands) {
      const params = paramsById.get(e.marketId)
      if (!params) continue
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

  const txRecords: TxRecord[] = []
  const onOutcome = (record: OutcomeRecord) => {
    const status = record.status as BlueActStatus
    if (status === 'quote_failed' || status === 'sim_reverted') backoff.record(record.id, head)
  }
  const actCounters = await runAct({
    ids,
    chainId: config.chainId,
    head,
    advisory: { backoff: backoff.dump(), inflightLabels: [...queue.inflightLabels()] },
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
    emit: record => (record.kind === 'tx' ? txRecords.push(record) : onOutcome(record)),
    logger
  })

  // 3. Submit — the queue signs/broadcasts each sim-ok tx; clear backoff only on a real pending entry.
  let submitted = 0
  for (const tx of txRecords) {
    const fees = initialFees(await signer.getBaseFee(), config.maxFeeWei)
    const { submitted: entered } = await queue.submit({
      request: { to: tx.to, data: tx.data },
      label: tx.id,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      blockNumber: head
    })
    if (entered) backoff.clear(tx.id)
    submitted += 1
  }

  // 4. Confirmations / stuck-detection / fee-bumps for the pending set (incl. prior ticks).
  await queue.onBlock(head)

  const counters: TickCounters = {
    pairs: senseCounters.pairs,
    liquidatable: senseCounters.liquidatable,
    planned: senseCounters.emitted,
    noSwapPath: actCounters.noSwapPath,
    quoteFailed: actCounters.quoteFailed,
    backoffSkipped: actCounters.backoffSkipped,
    ok: actCounters.ok,
    reverted: actCounters.reverted,
    submitted
  }
  logger.info('tick.end', { ...counters })

  return {
    counters,
    state: {
      version: STATE_VERSION,
      queue: queue.dump(),
      backoff: backoff.dump(),
      marketParams: resolveParams.dump()
    }
  }
}
