import type { Swap, Venue } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import {
  assertContractDeployed,
  createBackoff,
  createDeploylessClient,
  createLogger,
  createPendingQueue,
  createRunner,
  createSigner,
  initialFees,
  simulateLiquidationExec
} from '@repo/bot-kit'
import { createRateLimitedClient, createVenueSelector, priceByVenue } from '@repo/swaps'
import { delay, ensureError, tryCatch } from '@repo/utils'
import { erc20Abi } from 'viem'
import { getBlockNumber, readContract } from 'viem/actions'

import type { Market } from './execution/encode-call'
import type { LiquidationPlan } from './sizing/plan'

import { loadConfig } from './config'
import { SETTLED_COOLDOWN_BLOCKS } from './constants'
import {
  createApiCandidateSource,
  discoverBorrowers,
  MAX_DISCOVERY_PAGES
} from './discovery/borrowers'
import { createListedMarketFilter } from './discovery/markets'
import { encodeLiquidationExec } from './execution/encode-call'
import { composeQuoting } from './quotes'
import { readMidnightLiquidationLens } from './state/lens.sol'
import { runTick } from './tick/tick'
import { revertReason } from './tx-error'

async function main() {
  const config = loadConfig()
  const logger = createLogger(config.logLevel)

  // Signed-send path: a plain wallet client + local nonce cursor (separate from the deployless read
  // client). The EOA is the liquidator and the recipient of both end-of-exec token sweeps.
  const signer = createSigner({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback,
    sendRpcUrl: config.sendRpcUrl,
    privateKey: config.liquidatorPrivateKey
  })
  const eoa = signer.account.address

  logger.info('startup', {
    chainId: config.chainId,
    liquidator: eoa,
    callback: config.executooorAddress,
    midnight: config.midnight
  })

  // Read-only client shared by the lens and simulate paths. Validate EXECUTOOOR_ADDRESS holds code
  // before doing any work — fatal on a typo / not-yet-deployed address (liveness, not identity).
  const client = createDeploylessClient(config)
  await assertContractDeployed(
    client,
    config.executooorAddress,
    'EXECUTOOOR_ADDRESS',
    'deploy it with `bun run --filter @repo/contracts deploy:executor`'
  )

  // Enabled venues are inferred from which venue API keys are present (loadConfig already enforced the
  // no-key → bad-debt-only opt-in). Keys are read HERE, at the point of use, and live only in this
  // closure — never on the (logged) Config object.
  const apiKeys: Partial<Record<Venue, string>> = {}
  if (Bun.env.ZEROX_API_KEY) apiKeys['0x'] = Bun.env.ZEROX_API_KEY
  if (Bun.env.ONEINCH_API_KEY) apiKeys['1inch'] = Bun.env.ONEINCH_API_KEY
  const venues = config.venues.enabled
  if (venues.length === 0) {
    logger.warn('venues.none_enabled', {
      chainId: config.chainId,
      detail:
        'no venue API keys set — running bad-debt-only (positions discovered, bad debt realized, no swap-liquidations)'
    })
  } else {
    logger.info('quoting.startup', { chainId: config.chainId, venues })
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

  // Venue selector: caches a best-first venue ranking per pair from log-scaled indicative probes.
  // Decimals are read once per collateral (memoized in the selector); the collateral set is bounded by
  // the listed markets, so these are a handful of one-off reads over the process lifetime.
  const venueSelector = createVenueSelector({
    venues,
    chainId: config.chainId,
    ladderWholeTokens: config.probe.ladderWholeTokens,
    getDecimals: token =>
      readContract(client, { address: token, abi: erc20Abi, functionName: 'decimals' }),
    indicativeQuote: (venue, params) => priceByVenue(probeClient, { venue, baseUrls, params }),
    staleMs: config.probe.staleMs,
    logger
  })

  // Market whitelist: only listed markets are discovered / probed / liquidated. Refresh once at
  // startup (non-fatal — a failed first fetch leaves the set empty = fail-closed, and the timer below
  // retries), then poll on an interval.
  const listedMarkets = createListedMarketFilter({
    apiUrl: config.markets.apiUrl,
    chainId: config.chainId,
    logger
  })
  await tryCatch(listedMarkets.refresh())

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
    maxBlocks: config.quoting.backoffMaxBlocks
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
  // over-inclusive). The lens re-reads every returned pair fresh on-chain, so this is a coverage
  // source, never the source of truth.
  const fetchPage = createApiCandidateSource({
    url: config.discovery.apiUrl,
    chainId: config.chainId,
    healthFactorLte: config.discovery.healthFactorLte
  })
  // Filter candidates to the market whitelist BEFORE the lens read — a non-listed market is never
  // touched (fail-closed), and this also shrinks the lens batch.
  const discover = async () => {
    const candidates = await discoverBorrowers(fetchPage, { logger, maxPages: MAX_DISCOVERY_PAGES })
    const listed = candidates.filter(candidate => listedMarkets.isListed(candidate.marketId))
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
    revertReason
  })

  // Phase-4 runner: an HTTP block-poll watcher drives one tick per new block (coalescing backlog),
  // passing the polled height as the queue's submittedAtBlock. Each liquidatable position resolves its
  // swap step, simulates the real `exec_606BaXt`, and — on a sim-ok result — broadcasts that same exec
  // via the Executor singleton, then drives queue.onBlock.
  const tick = (chainHead: bigint) =>
    runTick({
      discover,
      chainHead,
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
          request: {
            to: config.executooorAddress,
            data: encodeExec(market, borrower, plan, swap)
          },
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

  const runner = createRunner({
    getBlockNumber: () => getBlockNumber(client),
    tick,
    logger,
    revertReason
  })
  runner.start()

  // Refresh the market whitelist on an interval, independent of the block loop, via a delay-spaced
  // self-reschedule (no busy loop). Each round is wrapped so a transient markets-API failure logs and
  // keeps last-known-good rather than killing the schedule (or emptying the whitelist). Also re-emits
  // the bad-debt-only health signal while no venue is keyed.
  let stopped = false
  const refreshMarketsLoop = async () => {
    await delay(config.markets.refreshMs)
    if (stopped) return
    const { error } = await tryCatch(listedMarkets.refresh())
    if (error) logger.warn('markets.refresh_failed', { detail: error.message })
    if (venues.length === 0) {
      logger.warn('venues.none_enabled', { detail: 'still no venue API keys — bad-debt-only' })
    }
    void refreshMarketsLoop()
  }
  void refreshMarketsLoop()

  // Graceful shutdown: stop the loops and dump the pending set (hashes + nonces) plus the venue /
  // whitelist state for observability. Sends are fire-and-forget and chain truth wins on restart, so
  // there is nothing to await-drain.
  const shutdown = (signal: string) => {
    stopped = true
    logger.info('shutdown', {
      signal,
      pending: queue.snapshot(),
      venues: venueSelector.snapshot(),
      listedMarkets: listedMarkets.snapshot()
    })
    void runner.stop().finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(error => {
  // Config/client never came up, so we cannot honor LOG_LEVEL — emit the failure directly, exit non-zero.
  console.error(
    JSON.stringify({ level: 'error', event: 'startup.error', error: ensureError(error).message })
  )
  process.exitCode = 1
})
