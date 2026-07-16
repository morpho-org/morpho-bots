import type { Logger } from '@repo/evm-kit'
import type { CooldownEntries, CooldownStore, TransactionRecord } from '@repo/pipeline'
import type { QuoteOutcome, SwapConfigEntry, SwapPlan, Venue } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { assertContractDeployed, createDeploylessClient } from '@repo/evm-kit'
import { createCooldownStore, rawRecordId, simulateLiquidationExec } from '@repo/pipeline'
import { createErc4626Unwrapper, createRateLimitedClient } from '@repo/swaps'
import { getAddress, isAddress, isHex } from 'viem'
import { getBlockNumber } from 'viem/actions'

import type { LiquidateConfig, Env } from '../config'
import type { LensInput, LensOut } from '../lens.sol'
import type { MarketParams } from '../market'
import type { LiquidationPlan } from '../sizing/plan'

import { loadLiquidateConfig } from '../config'
import { isLiquidatable, planInputFromLens } from '../eligibility'
import { encodeLiquidationExec } from '../execution/encode-call'
import { lensKey, readBlueLiquidationLens } from '../lens.sol'
import { marketId } from '../market'
import { composeQuoting } from '../quotes'
import { plan } from '../sizing/plan'

/**
 * `liquidate`'s disposable cache: the per-position failure-backoff cooldowns. Everything else is
 * re-derived fresh each tick; only the cooldown timestamps must survive across the per-tick process.
 */
export type BlueLiquidateCache = { cooldowns: CooldownEntries }

export type LiquidateCounters = {
  requested: number
  invalid: number
  notLiquidatable: number
  cooledDown: number
  noSwapPath: number
  quoteFailed: number
  ok: number
  reverted: number
}

type Evaluand = { id: string; marketId: Hex; borrower: Address; market: MarketParams }

function parsePosition(value: unknown, chainId: number): Evaluand | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const market = record.market
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
  if (typeof market !== 'object' || market === null || Array.isArray(market)) return null
  const params = market as Record<string, unknown>
  if (typeof params.loanToken !== 'string' || !isAddress(params.loanToken)) return null
  if (typeof params.collateralToken !== 'string' || !isAddress(params.collateralToken)) return null
  if (typeof params.oracle !== 'string' || !isAddress(params.oracle)) return null
  if (typeof params.irm !== 'string' || !isAddress(params.irm)) return null
  if (typeof params.lltv !== 'string' || !/^\d+$/.test(params.lltv)) return null
  const parsedMarket: MarketParams = {
    loanToken: getAddress(params.loanToken),
    collateralToken: getAddress(params.collateralToken),
    oracle: getAddress(params.oracle),
    irm: getAddress(params.irm),
    lltv: BigInt(params.lltv)
  }
  const suppliedId = record.marketId.toLowerCase() as Hex
  if (marketId(parsedMarket) !== suppliedId) return null
  return {
    id: record.id,
    marketId: suppliedId,
    borrower: getAddress(record.borrower),
    market: parsedMarket
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
 * positions are structured stderr events; only successful transactions reach stdout.
 */
export async function prepareLiquidations(deps: {
  records: readonly unknown[]
  chainId: number
  head: bigint
  readLens: (pairs: LensInput[]) => Promise<Map<string, LensOut>>
  quoteFor: (plan: LiquidationPlan, out: LensOut) => Promise<QuoteOutcome>
  simulate: (args: {
    market: MarketParams
    borrower: Address
    plan: LiquidationPlan
    swapPlan: SwapPlan
  }) => Promise<string | null>
  encodeExec: (
    market: MarketParams,
    borrower: Address,
    plan: LiquidationPlan,
    swapPlan: SwapPlan
  ) => Hex
  executor: Address
  cooldown: CooldownStore
  emit: (record: TransactionRecord) => void
  logger: Logger
}): Promise<LiquidateCounters> {
  const {
    records,
    chainId,
    head,
    readLens,
    quoteFor,
    simulate,
    encodeExec,
    executor,
    cooldown,
    emit,
    logger
  } = deps

  const counters: LiquidateCounters = {
    requested: records.length,
    invalid: 0,
    notLiquidatable: 0,
    cooledDown: 0,
    noSwapPath: 0,
    quoteFailed: 0,
    ok: 0,
    reverted: 0
  }

  const evaluands: Evaluand[] = []
  for (const record of records) {
    const parsed = parsePosition(record, chainId)
    if (!parsed) {
      const id = rawRecordId(record)
      logger.warn('transform.skip', { status: 'invalid_record', ...(id ? { id } : {}), record })
      counters.invalid += 1
      continue
    }
    evaluands.push(parsed)
  }

  if (evaluands.length === 0) {
    logger.info('transform.end', { ...counters })
    return counters
  }

  // Feed the wire-carried MarketParams straight to the lens: `parsePosition` already verified they
  // hash to the supplied marketId (they ARE the id's preimage), so the transform needs no on-chain
  // id→params resolution. Only the lens's mutable reads (debt, collateral, price) hit the chain.
  const inputs: LensInput[] = evaluands.map(e => ({ params: e.market, borrower: e.borrower }))
  const lensOut = await readLens(inputs)

  for (const item of evaluands) {
    const out = lensOut.get(lensKey(item.marketId, item.borrower))
    if (!out || !isLiquidatable(out)) {
      logger.info('transform.skip', { id: item.id, status: 'not_liquidatable', block: head })
      counters.notLiquidatable += 1
      continue
    }
    const liquidationPlan = plan(planInputFromLens(out))
    if (!liquidationPlan) {
      logger.info('transform.skip', {
        id: item.id,
        status: 'not_liquidatable',
        reason: 'degenerate_plan',
        block: head
      })
      counters.notLiquidatable += 1
      continue
    }
    // Backoff: a position whose last attempt failed to produce a submittable tx is skipped (no venue
    // quote) until its cooldown elapses. No-op when the cooldown is disabled (POSITION_LIQUIDATION_COOLDOWN_MS=0).
    if (cooldown.shouldSkip(item.id)) {
      logger.info('transform.skip', { id: item.id, status: 'cooldown', block: head })
      counters.cooledDown += 1
      continue
    }
    const outcome = await quoteFor(liquidationPlan, out)
    if (outcome.kind === 'no_config') {
      logger.warn('transform.skip', { id: item.id, status: 'no_swap_path', block: head })
      counters.noSwapPath += 1
      cooldown.mark(item.id)
      continue
    }
    if (outcome.kind === 'failed') {
      logger.warn('transform.skip', {
        id: item.id,
        status: 'quote_failed',
        reason: outcome.reason,
        block: head
      })
      counters.quoteFailed += 1
      cooldown.mark(item.id)
      continue
    }
    const swapPlan = outcome.plan

    const revert = await simulate({
      market: out.params,
      borrower: item.borrower,
      plan: liquidationPlan,
      swapPlan
    })
    if (revert !== null) {
      logger.warn('transform.skip', {
        id: item.id,
        status: 'sim_reverted',
        reason: revert,
        block: head
      })
      counters.reverted += 1
      cooldown.mark(item.id)
      continue
    }
    const data = encodeExec(out.params, item.borrower, liquidationPlan, swapPlan)
    emit(txRecord(item.id, chainId, executor, data, head))
    counters.ok += 1
  }

  logger.info('transform.end', { ...counters })
  return counters
}

/**
 * One `liquidate` pass at the current chain head: build the quote → simulate pipeline from `env`, run
 * {@link prepareLiquidations} over position records, and return the refreshed failure-backoff cooldowns for the
 * caller to persist. Needs venue API keys — read from the
 * env table at the point of use, never stored — but NOT the signer private key. Never touches the
 * filesystem, `process.stdout`, or `Bun.env`.
 *
 * `runStartupChecks` gates the boot-time Executor-code + swap-route diagnostics.
 */
export async function runLiquidate(
  env: Env,
  records: readonly unknown[],
  opts: {
    cache: BlueLiquidateCache | null
    runStartupChecks: boolean
    logger: Logger
    emit: (record: TransactionRecord) => void
  }
): Promise<{ cache: BlueLiquidateCache }> {
  const config: LiquidateConfig = loadLiquidateConfig(env)
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
  if (env.LIFI_API_KEY) apiKeys.lifi = env.LIFI_API_KEY
  const httpClient = createRateLimitedClient({
    apiKeys,
    rps: config.quoting.httpRps,
    burst: config.quoting.httpBurst,
    maxRetries: config.quoting.httpMaxRetries,
    timeoutMs: config.quoting.quoteTimeoutMs
  })
  // Pre-swap converters for exotic collateral (ERC4626 shares → underlying). Auto-detecting with
  // per-process memoization; a collateral with its own config entry bypasses them entirely.
  const unwrappers = [createErc4626Unwrapper({ client, logger })]
  const { quoteFor } = composeQuoting({
    httpClient,
    chainId: config.chainId,
    executor: config.executooorAddress,
    swapByCollateral,
    maxRouteImpactBps: config.quoting.maxRouteImpactBps,
    unwrappers,
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
    swapPlan: SwapPlan
  ): Hex =>
    encodeLiquidationExec({
      executor: config.executooorAddress,
      morpho: config.morpho,
      market,
      seizedAssets: p.seizedAssets,
      borrower,
      plan: swapPlan,
      recipient: eoa
    })

  const cooldown = createCooldownStore({
    cooldownMs: config.positionCooldownMs,
    initial: opts.cache?.cooldowns
  })

  const head = await getBlockNumber(client)
  await prepareLiquidations({
    records,
    chainId: config.chainId,
    head,
    // The transform trusts the wire-carried, hash-verified MarketParams (see prepareLiquidations),
    // so the lens reads mutable state directly for each supplied pair — no id→params resolver.
    readLens: pairs => readBlueLiquidationLens(client, config.morpho, pairs),
    quoteFor,
    simulate: async ({ market, borrower, plan: p, swapPlan }) => {
      const result = await simulateLiquidationExec(client, {
        executooor: config.executooorAddress,
        eoa,
        data: encodeExec(market, borrower, p, swapPlan)
      })
      return result.status === 'ok' ? null : (result.reason ?? 'revert')
    },
    encodeExec,
    executor: config.executooorAddress,
    cooldown,
    emit,
    logger
  })

  return { cache: { cooldowns: cooldown.dump() } }
}
