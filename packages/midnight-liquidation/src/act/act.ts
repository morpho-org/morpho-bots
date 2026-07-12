import type { Logger, TransactionRecord } from '@repo/bot-kit'
import type { QuoteOutcome, Swap, Venue, VenueSelectorState } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import {
  assertContractDeployed,
  createDeploylessClient,
  simulateLiquidationExec
} from '@repo/bot-kit'
import { createRateLimitedClient, createVenueSelector, priceByVenue } from '@repo/swaps'
import { erc20Abi, getAddress, isAddress, isHex } from 'viem'
import { getBlockNumber, readContract } from 'viem/actions'

import type { ActConfig, Env } from '../config'
import type { Market } from '../execution/encode-call'
import type { LiquidationPlan } from '../sizing/plan'
import type { LensInput, LensOut } from '../state/lens.sol'

import { loadActConfig } from '../config'
import { encodeLiquidationExec } from '../execution/encode-call'
import { composeQuoting } from '../quotes'
import { isBadDebtRealization, plan } from '../sizing/plan'
import { lensKey, readMidnightLiquidationLens } from '../state/lens.sol'
import { isLiquidatable, planInputFromLens } from '../tick/eligibility'

/** `act`'s disposable cache: the venue selector's per-pair ladder rankings + decimals. */
export type MidnightActCache = VenueSelectorState

export type ActCounters = {
  requested: number
  invalid: number
  notLiquidatable: number
  noSwapPath: number
  quoteFailed: number
  ok: number
  reverted: number
}

type Evaluand = { id: string; marketId: Hex; borrower: Address }

function parsePosition(value: unknown, chainId: number): Evaluand | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.kind !== 'position' ||
    record.chainId !== chainId ||
    typeof record.id !== 'string' ||
    record.id.trim() === ''
  )
    return null
  if (
    typeof record.marketId !== 'string' ||
    !isHex(record.marketId) ||
    record.marketId.length !== 66
  )
    return null
  if (typeof record.borrower !== 'string' || !isAddress(record.borrower)) return null
  return {
    id: record.id,
    marketId: record.marketId.toLowerCase() as Hex,
    borrower: getAddress(record.borrower)
  }
}

function txRecord(
  id: string,
  chainId: number,
  to: Address,
  data: Hex,
  block: bigint
): TransactionRecord {
  return {
    kind: 'transaction',
    id,
    chainId,
    to,
    data,
    value: '0',
    simulatedAtBlock: Number(block)
  }
}

/**
 * Maps transparent position records to freshly simulated transactions. Invalid or non-actionable
 * positions are structured stderr events; only successful transactions reach stdout. Pure bad-debt
 * realization skips quoting.
 */
export async function runAct(deps: {
  records: readonly unknown[]
  chainId: number
  head: bigint
  seizeCapMarginBps: number
  readLensForPositions: (evaluands: readonly Evaluand[]) => Promise<Map<string, LensOut>>
  quoteFor: (plan: LiquidationPlan, out: LensOut) => Promise<QuoteOutcome>
  simulate: (args: {
    market: Market
    borrower: Address
    plan: LiquidationPlan
    swap: Swap | null
  }) => Promise<string | null>
  encodeExec: (market: Market, borrower: Address, plan: LiquidationPlan, swap: Swap | null) => Hex
  executor: Address
  emit: (record: TransactionRecord) => void
  logger: Logger
}): Promise<ActCounters> {
  const {
    records,
    chainId,
    head,
    seizeCapMarginBps,
    readLensForPositions,
    quoteFor,
    simulate,
    encodeExec,
    executor,
    emit,
    logger
  } = deps

  const counters: ActCounters = {
    requested: records.length,
    invalid: 0,
    notLiquidatable: 0,
    noSwapPath: 0,
    quoteFailed: 0,
    ok: 0,
    reverted: 0
  }

  const evaluands: Evaluand[] = []
  for (const record of records) {
    const parsed = parsePosition(record, chainId)
    if (!parsed) {
      logger.warn('act.skip', { status: 'invalid_record', record })
      counters.invalid += 1
      continue
    }
    evaluands.push(parsed)
  }

  if (evaluands.length === 0) {
    logger.info('act.end', { ...counters })
    return counters
  }

  const lensOut = await readLensForPositions(evaluands)

  for (const item of evaluands) {
    const out = lensOut.get(lensKey(item.marketId, item.borrower))
    if (!out || !isLiquidatable(out)) {
      logger.info('act.skip', { id: item.id, status: 'not_liquidatable', block: head })
      counters.notLiquidatable += 1
      continue
    }
    const liquidationPlan = plan(planInputFromLens(out), { seizeCapMarginBps })
    if (!liquidationPlan) {
      logger.info('act.skip', {
        id: item.id,
        status: 'not_liquidatable',
        reason: 'degenerate_plan',
        block: head
      })
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
        logger.warn('act.skip', { id: item.id, status: 'no_swap_path', block: head })
        counters.noSwapPath += 1
        continue
      }
      if (outcome.kind === 'failed') {
        logger.warn('act.skip', {
          id: item.id,
          status: 'quote_failed',
          reason: outcome.reason,
          block: head
        })
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
      logger.warn('act.skip', { id: item.id, status: 'sim_reverted', reason: revert, block: head })
      counters.reverted += 1
      continue
    }
    const data = encodeExec(out.market, item.borrower, liquidationPlan, swap)
    emit(txRecord(item.id, chainId, executor, data, head))
    counters.ok += 1
  }

  logger.info('act.end', { ...counters })
  return counters
}

/**
 * One `act` pass at the current chain head: build the multi-venue quote → simulate pipeline from
 * `env`, run {@link runAct} over positions, and return the refreshed venue-selector cache for the caller
 * to persist. Needs venue API keys — read from the env table at the point of use, never stored — but
 * NOT the signer private key. Never touches the filesystem, `process.stdout`, or `Bun.env`.
 *
 * `runStartupChecks` gates the boot-time Executor-code + venue diagnostics.
 */
export async function actOnce(
  env: Env,
  records: readonly unknown[],
  opts: {
    cache: MidnightActCache | null
    runStartupChecks: boolean
    logger: Logger
    emit: (record: TransactionRecord) => void
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

  const readLensForPositions = async (
    evaluands: readonly Evaluand[]
  ): Promise<Map<string, LensOut>> => {
    const inputs: LensInput[] = evaluands.map(e => ({
      id: e.marketId,
      borrower: e.borrower,
      caller: config.executooorAddress
    }))
    return readMidnightLiquidationLens(client, config.midnight, inputs)
  }

  const head = await getBlockNumber(client)
  await runAct({
    records,
    chainId: config.chainId,
    head,
    seizeCapMarginBps: config.quoting.seizeCapMarginBps,
    readLensForPositions,
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
