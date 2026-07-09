import type { BackoffState, Logger, PendingQueueState } from '@repo/bot-kit'
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

import type { Env } from './config'
import type { MarketParams } from './market'
import type { TickCounters } from './runner/tick'
import type { LiquidationPlan } from './sizing/plan'
import type { MarketParamsCache } from './state/market-params'

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

export type { Config, Env } from './config'
export type { TickCounters } from './runner/tick'
export { loadConfig } from './config'

/** Bumped when the persisted-state shape changes; a mismatched file is discarded, not migrated. */
export const STATE_VERSION = 1

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
 * One full liquidation cycle at the current chain head, then return. This is the composition the
 * long-lived runner used to own, reshaped for one-shot invocation (CLI loop / cron): build the
 * pipeline from `env`, restore cross-tick state, run `runTick` once, and dump state for the caller
 * to persist. The core never touches the filesystem for state — only the caller does.
 *
 * ALL env — including venue API keys — is read from the `env` table, never from `Bun.env`, so
 * file-sourced secrets reach the venue adapters. Keys live only in this closure, never on the
 * (logged) `Config`.
 *
 * `runStartupChecks` gates the boot-time liveness checks (Executor/Morpho code, discovery
 * diagnostics) so they run on a fresh host rather than every ~2s tick. The caller sets it from "no
 * state file existed" — explicitly, so a caller passing restored state skips them deliberately.
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

  // Per-collateral swap routing for this chain, keyed by EIP-55-checksummed collateral address. A
  // collateral with no entry is skipped at tick time (`config.no_swap_path`) — a coverage gap, not
  // fatal.
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
  const backoff = createBackoff({
    baseBlocks: config.quoting.backoffBaseBlocks,
    maxBlocks: config.quoting.backoffMaxBlocks,
    ...(state ? { initialState: state.backoff } : {})
  })

  // The exec calldata for one liquidation — the same bytes the simulate gate checks and the queue
  // broadcasts, so a sim-ok plan and its broadcast can't drift.
  const encodeExec = (
    market: MarketParams,
    borrower: Address,
    plan: LiquidationPlan,
    swap: Swap
  ): Hex =>
    encodeLiquidationExec({
      executor: config.executooorAddress,
      morpho: config.morpho,
      market,
      seizedAssets: plan.seizedAssets,
      borrower,
      swap,
      recipient: eoa
    })

  const resolveParams = createMarketParamsResolver(
    multicallIdToMarketParams(client, config.morpho),
    state?.marketParams
  )
  const discover = () => discoverCandidates(query, resolveParams, config.network)

  // Startup discovery self-check (non-fatal): surface the rindexer schema + first discovery result
  // so a column-name mismatch or a not-yet-migrated table is diagnosable from logs on a fresh host,
  // rather than as an opaque per-tick `tick.error`.
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
  const counters = await runTick({
    discover,
    syncedBlock: () => rindexerSyncedBlock(query, config.network),
    chainHead: head,
    readLens: pairs => readBlueLiquidationLens(client, config.morpho, pairs),
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
      marketParams: resolveParams.dump()
    }
  }
}
