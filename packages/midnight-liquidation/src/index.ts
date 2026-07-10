import type {
  BackoffState,
  Logger,
  OutcomeRecord,
  PendingQueueState,
  TxRecord
} from '@repo/bot-kit'
import type { Swap, Venue, VenueSelectorState } from '@repo/swaps'
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
import { createRateLimitedClient, createVenueSelector, priceByVenue } from '@repo/swaps'
import { tryCatch } from '@repo/utils'
import { erc20Abi } from 'viem'
import { getBlockNumber, readContract } from 'viem/actions'

import type { MidnightActStatus, MidnightActCache } from './act/act'
import type { Env } from './config'
import type { ListedMarketsState } from './discovery/markets'
import type { Market } from './execution/encode-call'
import type { MidnightSenseCache } from './sense/sense'
import type { LiquidationPlan } from './sizing/plan'
import type { LensInput, LensOut } from './state/lens.sol'

import { runAct } from './act/act'
import { loadConfig } from './config'
import { LISTED_MARKETS_MAX_AGE_MS, SETTLED_COOLDOWN_BLOCKS } from './constants'
import {
  createApiCandidateSource,
  discoverBorrowers,
  MAX_DISCOVERY_PAGES
} from './discovery/borrowers'
import { createListedMarketFilter } from './discovery/markets'
import { encodeLiquidationExec } from './execution/encode-call'
import { composeQuoting } from './quotes'
import { runSense } from './sense/sense'
import { lensKey, readMidnightLiquidationLens } from './state/lens.sol'
import { revertReason } from './tx-error'

export type { Config, Env, SenseConfig, ActConfig } from './config'
export { loadConfig, loadSenseConfig, loadActConfig } from './config'
export { DOMAIN, formatOpportunityId, parseOpportunityId } from './wire'
export type { ParsedOpportunityId } from './wire'
export { runSense, senseOnce } from './sense/sense'
export type { MidnightSenseCache, SenseCounters } from './sense/sense'
export { runAct, actOnce } from './act/act'
export type { MidnightActStatus, MidnightActCache, ActCounters } from './act/act'

/** Bumped when the persisted-state shape or its label format changes; a mismatched file is discarded,
 * not migrated. v2: labels/ids are now the `midnight:liq:…` wire id, not the old `${id}:${borrower}`. */
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
 * section is reconciled against receipts on the next tick's `onBlock`, the whitelist is re-fetched
 * when stale (and treated as empty past its fail-closed max-age), and venue rankings stay
 * `staleMs`-gated. A lost/corrupt file degrades to today's restart semantics.
 */
export type MidnightPersistedState = {
  version: number
  queue: PendingQueueState
  backoff: BackoffState
  listedMarkets: ListedMarketsState
  venues: VenueSelectorState
}

/**
 * @deprecated One-shot composition of the split stages, kept only so the CLI's `tick` command and its
 * spawn tests stay green through the pipeline migration. Deleted in the next PR once the CLI wires
 * `sense`/`act`/`queue` directly. New callers use {@link senseOnce} / {@link actOnce}.
 *
 * Runs the pipeline once at the current head: refresh the whitelist → sense → collect emitted ids →
 * act → submit the emitted tx records via the queue → `onBlock`. Preserves the pre-split signature
 * and persisted-state shape. Everything is keyed by the `midnight:liq:…` wire id (backoff, inflight,
 * queue labels), and the {@link STATE_VERSION} bump discards any old `${id}:${borrower}`-keyed file
 * cleanly. All env — including venue API keys — is read from the `env` table, never `Bun.env`.
 */
export async function tickOnce(
  env: Env,
  opts: { state?: MidnightPersistedState; runStartupChecks?: boolean; logger?: Logger } = {}
): Promise<{ counters: TickCounters; state: MidnightPersistedState }> {
  const config = loadConfig(env)
  const logger = opts.logger ?? createLogger(config.logLevel)
  const state = opts.state?.version === STATE_VERSION ? opts.state : undefined

  const signer = createSigner({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback,
    sendRpcUrl: config.sendRpcUrl,
    privateKey: config.liquidatorPrivateKey
  })
  const eoa = signer.account.address

  const client = createDeploylessClient(config)
  if (opts.runStartupChecks) {
    logger.info('startup', {
      chainId: config.chainId,
      liquidator: eoa,
      callback: config.executooorAddress,
      midnight: config.midnight
    })
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
    ...(state ? { initialState: state.venues } : {})
  })

  // Market whitelist, refreshed INLINE when stale. Transient failure keeps last-known-good; past the
  // fail-closed max-age the set is treated as EMPTY so a delisted market can never linger in scope.
  const listedMarkets = createListedMarketFilter({
    apiUrl: config.markets.apiUrl,
    chainId: config.chainId,
    logger,
    ...(state ? { initialState: state.listedMarkets } : {})
  })
  const whitelistAge = () => {
    const { updatedAt } = listedMarkets.snapshot()
    return updatedAt === null ? Infinity : Date.now() - updatedAt
  }
  if (whitelistAge() >= config.markets.refreshMs) {
    const { error } = await tryCatch(listedMarkets.refresh())
    if (error) {
      logger.warn('markets.refresh_failed', { detail: error.message })
      if (venues.length === 0) {
        logger.warn('venues.none_enabled', { detail: 'still no venue API keys — bad-debt-only' })
      }
    }
  }
  const whitelistExpired = whitelistAge() > LISTED_MARKETS_MAX_AGE_MS
  if (whitelistExpired) {
    logger.warn('markets.whitelist_expired', {
      ageMs: whitelistAge(),
      detail: 'whitelist older than max age — treating as empty (fail-closed) until a refresh lands'
    })
  }
  const isListed = (marketId: Hex) => !whitelistExpired && listedMarkets.isListed(marketId)

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
  const backoff = createBackoff({
    baseBlocks: config.quoting.backoffBaseBlocks,
    maxBlocks: config.quoting.backoffMaxBlocks,
    ...(state ? { initialState: state.backoff } : {})
  })

  const encodeExec = (
    market: Market,
    borrower: Address,
    liquidationPlan: LiquidationPlan,
    swap: Swap | null
  ): Hex =>
    encodeLiquidationExec({
      executor: config.executooorAddress,
      midnight: config.midnight,
      market,
      collateralIndex: liquidationPlan.collateralIndex,
      seizedAssets: liquidationPlan.seizedAssets,
      repaidUnits: liquidationPlan.repaidUnits,
      borrower,
      postMaturityMode: liquidationPlan.postMaturityMode,
      swap,
      recipient: eoa
    })

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

  const queue = createPendingQueue({
    send: signer.send,
    getReceipt: signer.getReceipt,
    getBaseFee: signer.getBaseFee,
    syncNonce: signer.syncNonce,
    maxFeeWei: config.maxFeeWei,
    logger,
    settledCooldownBlocks: SETTLED_COOLDOWN_BLOCKS,
    revertReason,
    ...(state ? { initialState: state.queue } : {})
  })

  const head = await getBlockNumber(client)

  // 1. Sense — collect the emitted wire ids.
  const ids: string[] = []
  const senseCounters = await runSense({
    chainId: config.chainId,
    caller: config.executooorAddress,
    discover,
    chainHead: head,
    readLens: pairs => readMidnightLiquidationLens(client, config.midnight, pairs),
    emit: record => ids.push(record.id),
    logger
  })

  // 2. Act — re-derive each id and collect tx records; map failure outcomes onto backoff (the role
  //    the queue command will own once the CLI lands).
  const readLensForIds = async (
    evaluands: readonly { id: string; marketId: Hex; borrower: Address }[]
  ): Promise<Map<string, LensOut>> => {
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

  const txRecords: TxRecord[] = []
  const onOutcome = (record: OutcomeRecord) => {
    const status = record.status as MidnightActStatus
    if (status === 'quote_failed' || status === 'sim_reverted') backoff.record(record.id, head)
  }
  const actCounters = await runAct({
    ids,
    chainId: config.chainId,
    head,
    seizeCapMarginBps: config.quoting.seizeCapMarginBps,
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
      listedMarkets: listedMarkets.dump(),
      venues: venueSelector.dump()
    }
  }
}
