import type { QueueState } from '@repo/bot-kit'
import type { SwapConfigEntry, SwapPlan, Venue } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import {
  assertContractDeployed,
  botStatePaths,
  createBalanceMonitor,
  createBackoff,
  createCooldownStore,
  createDeploylessClient,
  createLogger,
  createOutcomeJournal,
  createPendingQueue,
  createRunner,
  createSigner,
  initialFees,
  loadState,
  QUEUE_STATE_VERSION,
  saveState,
  simulateLiquidationExec
} from '@repo/bot-kit'
import {
  createErc4626Unwrapper,
  createPendlePtUnwrapper,
  createRateLimitedClient,
  PENDLE_CHAIN_IDS
} from '@repo/swaps'
import { ensureError, tryCatch } from '@repo/utils'
import { getAddress } from 'viem'
import { getBlockNumber } from 'viem/actions'

import type { MarketParams } from './market'
import type { LiquidationPlan } from './sizing/plan'

import { loadConfig } from './config'
import {
  createPostgresQuery,
  discoverCandidates,
  discoveryDiagnostics,
  rindexerSyncedBlock
} from './discovery/borrowers'
import { encodeLiquidationExec } from './execution/encode-call'
import { composeQuoting } from './quotes'
import { runTick } from './runner/tick'
import { readBlueLiquidationLens } from './state/lens.sol'
import { createMarketParamsResolver, multicallIdToMarketParams } from './state/market-params'

async function main() {
  const config = loadConfig()
  const logger = createLogger(config.logLevel)

  // Signed-send path: a plain wallet client + local nonce cursor (separate from the deployless read
  // client). The EOA is the liquidator and the recipient of both end-of-exec token sweeps.
  const signer = createSigner({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback,
    privateKey: config.liquidatorPrivateKey
  })
  const eoa = signer.account.address

  logger.info('startup', {
    chainId: config.chainId,
    network: config.network,
    liquidator: eoa,
    callback: config.executooorAddress,
    morpho: config.morpho
  })

  // Read-only client shared by the lens and simulate paths. Validate both the Executor and the Morpho
  // singleton hold code before doing any work — fatal on a typo / not-yet-deployed address (liveness,
  // not identity).
  const client = createDeploylessClient(config)
  await assertContractDeployed(
    client,
    config.executooorAddress,
    'EXECUTOOOR_ADDRESS',
    'deploy it with `bun run --filter @repo/contracts deploy:executor`'
  )
  await assertContractDeployed(client, config.morpho, 'Morpho singleton')

  // Per-collateral swap routing for this chain, keyed by EIP-55-checksummed collateral address (the
  // config schema and the lens both return checksummed addresses). A collateral with no entry is
  // skipped at tick time (`config.no_swap_path`) — a coverage gap, not fatal.
  const swapByCollateral = new Map<string, SwapConfigEntry>()
  for (const [token, entry] of Object.entries(config.swapConfig[String(config.chainId)] ?? {})) {
    if (entry) swapByCollateral.set(getAddress(token), entry)
  }
  // No routes configured for this chain (unset/absent swap config): the bot still runs — it
  // identifies liquidatable borrowers — but skips every routed liquidation (`config.no_swap_path`).
  // Warn loudly so this isn't mistaken for a healthy, fully armed deployment. Otherwise log the
  // chosen venue per collateral.
  if (swapByCollateral.size === 0) {
    logger.warn('swap_config.no_routes', {
      chainId: config.chainId,
      detail: 'no swap routes configured — every liquidation will be skipped (config.no_swap_path)'
    })
  } else {
    logger.info('quoting.startup', {
      chainId: config.chainId,
      venues: Object.fromEntries(
        [...swapByCollateral].map(([token, entry]) => [token, entry.venue])
      )
    })
  }

  // Rate-limited HTTP client for aggregator quotes. API keys are read from env HERE, at the point of
  // use, and live only in this closure — never on the (logged) Config object.
  const apiKeys: Partial<Record<Venue, string>> = {}
  if (Bun.env.ZEROX_API_KEY) apiKeys['0x'] = Bun.env.ZEROX_API_KEY
  if (Bun.env.ONEINCH_API_KEY) apiKeys['1inch'] = Bun.env.ONEINCH_API_KEY
  if (Bun.env.LIFI_API_KEY) apiKeys.lifi = Bun.env.LIFI_API_KEY
  const httpClient = createRateLimitedClient({
    apiKeys,
    rps: config.quoting.httpRps,
    burst: config.quoting.httpBurst,
    maxRetries: config.quoting.httpMaxRetries,
    timeoutMs: config.quoting.quoteTimeoutMs
  })
  // Pre-swap converters for exotic collateral (ERC4626 shares, Pendle PTs → underlying).
  // Auto-detecting with per-process memoization; a collateral with its own config entry bypasses
  // them entirely. erc4626 first: a memoized eth_call beats consulting the markets list. Pendle is
  // only constructed on chains it is deployed to — elsewhere a cold-cache markets outage would fail
  // plain-collateral quotes too. The Pendle markets list is cached in-process for the bot's lifetime
  // (a 6h TTL inside the unwrapper handles staleness), so it is built once here.
  const pendle = PENDLE_CHAIN_IDS.has(config.chainId)
    ? createPendlePtUnwrapper({
        client: httpClient,
        chainId: config.chainId,
        slippageBps: config.quoting.pendleSlippageBps,
        logger
      })
    : null
  const unwrappers = [createErc4626Unwrapper({ client, logger }), ...(pendle ? [pendle] : [])]
  const { quoteFor } = composeQuoting({
    httpClient,
    chainId: config.chainId,
    executor: config.executooorAddress,
    swapByCollateral,
    maxRouteImpactBps: config.quoting.maxRouteImpactBps,
    unwrappers,
    logger
  })
  const backoff = createBackoff({
    baseBlocks: config.quoting.backoffBaseBlocks,
    maxBlocks: config.quoting.backoffMaxBlocks
  })
  // Opt-in per-position cooldown (default disabled): one in-memory store for the process lifetime,
  // complementary to `backoff` (see POSITION_LIQUIDATION_COOLDOWN_MS).
  const cooldown = createCooldownStore({ cooldownMs: config.positionCooldownMs })

  // The exec calldata for one liquidation — the same bytes the simulate gate checks and the queue
  // broadcasts, so a sim-ok plan and its broadcast can't drift.
  const encodeExec = (
    market: MarketParams,
    borrower: Address,
    plan: LiquidationPlan,
    swapPlan: SwapPlan
  ): Hex =>
    encodeLiquidationExec({
      executor: config.executooorAddress,
      morpho: config.morpho,
      market,
      seizedAssets: plan.seizedAssets,
      borrower,
      plan: swapPlan,
      recipient: eoa
    })

  const query = createPostgresQuery(config.databaseUrl)
  // Discovery is (id, borrower) from the indexed Borrow events; the market's immutable params are
  // recovered on-chain via idToMarketParams(id) and cached (params never change per id), so
  // steady-state ticks make no extra RPC calls once every market has been seen once.
  const resolveParams = createMarketParamsResolver(multicallIdToMarketParams(client, config.morpho))
  const discover = () => discoverCandidates(query, resolveParams, config.network)

  // Startup discovery self-check (non-fatal): surface the rindexer schema + first discovery result so
  // a column-name mismatch or a not-yet-migrated table is diagnosable from Railway logs at boot,
  // rather than as an opaque per-tick `tick.error`. rindexer may still be starting/migrating on first
  // deploy, so a failure here is logged and the bot proceeds — the per-block tick retries discovery.
  {
    const diag = await tryCatch(discoveryDiagnostics(query))
    if (diag.error) {
      logger.warn('discovery.startup_error', { detail: ensureError(diag.error).message })
    } else {
      logger.info('discovery.schema', {
        network: config.network,
        // The ACTUAL rindexer `borrow` column names — compare against what BORROWER_IDS_SQL selects
        // if discovery yields zero candidates while rindexer is synced.
        borrow: diag.data.borrow
      })
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
          // A sample so the join's parsed MarketParams can be eyeballed (non-zero addresses/lltv).
          sample: candidates[0] ?? null
        })
      }
    }
  }

  // Persisted transaction-queue state + a terminal-outcome audit trail, both under BOT_STATE_DIR
  // (default ~/.morpho-bots), namespaced by bot + chain. Restoring the pending set on boot preserves
  // stuck-detection (`submittedAtBlock`) and bump counts across restarts; chain truth still wins, as
  // the next `onBlock` reconciles every restored entry against receipts and the consumed nonce.
  const { stateFile, outcomesFile } = botStatePaths('blue-liquidation', config.chainId)
  const { state, reset } = loadState<QueueState>(stateFile, QUEUE_STATE_VERSION)
  if (reset && reset !== 'missing') logger.warn('state.reset', { reason: reset })
  const journal = createOutcomeJournal({ path: outcomesFile, chainId: config.chainId })
  const persist = () =>
    saveState(stateFile, { version: QUEUE_STATE_VERSION, queue: queue.dump() } satisfies QueueState)

  const queue = createPendingQueue({
    send: signer.send,
    getReceipt: signer.getReceipt,
    getBaseFee: signer.getBaseFee,
    getConsumedNonce: signer.consumedNonce,
    maxFeeWei: config.maxFeeWei,
    logger,
    ...(state ? { initialState: state.queue } : {}),
    onSettled: settlement => journal.record(settlement)
  })

  // Periodic EOA-balance metric so operators can watch gas drain (see `signer.balance`).
  const balanceMonitor = createBalanceMonitor({
    address: eoa,
    read: signer.balance,
    logger
  })

  // An HTTP block-poll watcher drives one tick per new block (coalescing backlog), passing the polled
  // height as both the rindexer-lag reference and the queue's submittedAtBlock. Each liquidatable
  // position resolves its swap, simulates the real `exec_606BaXt`, and — on a sim-ok result —
  // broadcasts that same exec via the Executor singleton, then drives queue.onBlock.
  const tick = (chainHead: bigint) =>
    runTick({
      discover,
      syncedBlock: () => rindexerSyncedBlock(query, config.network),
      chainHead,
      readLens: pairs => readBlueLiquidationLens(client, config.morpho, pairs),
      quoteFor,
      simulate: ({ market, borrower, plan, swapPlan }) =>
        simulateLiquidationExec(client, {
          executooor: config.executooorAddress,
          eoa,
          data: encodeExec(market, borrower, plan, swapPlan)
        }),
      submit: async ({ market, borrower, plan, swapPlan, blockNumber, label }) => {
        const fees = initialFees(await signer.getBaseFee(), config.maxFeeWei)
        await queue.submit({
          request: {
            to: config.executooorAddress,
            data: encodeExec(market, borrower, plan, swapPlan)
          },
          label,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          blockNumber
        })
        persist()
      },
      backoff,
      cooldown,
      pendingOnBlock: async blockNumber => {
        await queue.onBlock(blockNumber)
        persist()
        await balanceMonitor.maybeLog(blockNumber)
      },
      inflightLabels: () => queue.inflightLabels(),
      logger
    })

  const runner = createRunner({ getBlockNumber: () => getBlockNumber(client), tick, logger })
  runner.start()

  // Graceful shutdown: stop the watcher and dump the pending set (hashes + nonces). Sends are
  // fire-and-forget and chain truth wins on restart, so there is nothing to await-drain.
  const shutdown = (signal: string) => {
    logger.info('shutdown', { signal, pending: queue.snapshot() })
    persist()
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
