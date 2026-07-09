import type { BackoffState, Logger, PendingQueueState } from '@repo/bot-kit'
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

import type { Env } from './config'
import type { ListedMarketsState } from './discovery/markets'
import type { Market } from './execution/encode-call'
import type { TickCounters } from './runner/tick'
import type { LiquidationPlan } from './sizing/plan'

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
import { runTick } from './runner/tick'
import { readMidnightLiquidationLens } from './state/lens.sol'
import { revertReason } from './tx-error'

export type { Config, Env } from './config'
export type { TickCounters } from './runner/tick'
export { loadConfig } from './config'

/** Bumped when the persisted-state shape changes; a mismatched file is discarded, not migrated. */
export const STATE_VERSION = 1

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
 * One full liquidation cycle at the current chain head, then return. This is the composition the
 * long-lived runner used to own, reshaped for one-shot invocation (CLI loop / cron): build the
 * pipeline from `env`, restore cross-tick state, refresh the market whitelist inline when stale
 * (replacing the old second refresh loop), run `runTick` once, and dump state for the caller to
 * persist. The core never touches the filesystem for state — only the caller does.
 *
 * ALL env — including venue API keys — is read from the `env` table, never from `Bun.env`, so
 * file-sourced secrets reach the venue adapters. Keys live only in this closure, never on the
 * (logged) `Config`.
 *
 * `runStartupChecks` gates the boot-time liveness checks (Executor code, startup logs) so they run
 * on a fresh host rather than every ~2s tick. The caller sets it from "no state file existed".
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

  // Venue API keys come from the env TABLE (point of use), so file-sourced secrets work; they stay
  // in this closure and are never stored on the logged Config. Enabled venues were already derived
  // from the same table by loadConfig, so the two can't disagree.
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

  // Two rate-limited HTTP clients, each with its own per-venue token buckets: one for time-sensitive
  // FIRM quotes, and a separate, slower one for BACKGROUND probes — so a probe burst can never queue
  // ahead of a live liquidation's firm quote on the same venue's bucket.
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

  // Market whitelist, refreshed INLINE when stale (the persistent process used a second timer loop
  // for this). Transient failure keeps last-known-good; past the fail-closed max-age the set is
  // treated as EMPTY so a delisted market can never linger in scope on the back of an old file.
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
      // Re-emit the bad-debt-only health signal at refresh cadence (mirrors the old timer loop).
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

  // The exec calldata for one liquidation — the same bytes the simulate gate checks and the queue
  // broadcasts, so a sim-ok plan and its broadcast can't drift.
  const encodeExec = (
    market: Market,
    borrower: Address,
    plan: LiquidationPlan,
    swap: Swap | null
  ): Hex =>
    encodeLiquidationExec({
      executor: config.executooorAddress,
      midnight: config.midnight,
      market,
      collateralIndex: plan.collateralIndex,
      seizedAssets: plan.seizedAssets,
      repaidUnits: plan.repaidUnits,
      borrower,
      postMaturityMode: plan.postMaturityMode,
      swap,
      recipient: eoa
    })

  // Borrower discovery: poll the markets liquidation-candidates endpoint (cursor-paginated,
  // over-inclusive), filtered to the whitelist BEFORE the lens read (fail-closed).
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
  const counters = await runTick({
    discover,
    chainHead: head,
    caller: config.executooorAddress,
    seizeCapMarginBps: config.quoting.seizeCapMarginBps,
    readLens: pairs => readMidnightLiquidationLens(client, config.midnight, pairs),
    quoteFor,
    simulate: ({ market, borrower, plan, swap }) =>
      simulateLiquidationExec(client, {
        executooor: config.executooorAddress,
        eoa,
        data: encodeExec(market, borrower, plan, swap)
      }),
    submit: async ({ market, borrower, plan, swap, blockNumber, label }) => {
      const fees = initialFees(await signer.getBaseFee(), config.maxFeeWei)
      await queue.submit({
        request: { to: config.executooorAddress, data: encodeExec(market, borrower, plan, swap) },
        label,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        blockNumber
      })
    },
    backoff,
    pendingOnBlock: blockNumber => queue.onBlock(blockNumber),
    inflightLabels: () => queue.inflightLabels(),
    logger
  })

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
