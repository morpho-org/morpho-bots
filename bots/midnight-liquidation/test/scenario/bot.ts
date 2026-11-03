import type { Budget, Keyed, RunnerOptions } from '@repo/engine'
import type { KernelConfig, TxPayload } from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { PairCurve, QuoteOutcome, SwapPlan } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { Executor, MidnightAbi } from '@repo/contracts'
import { FakeChain, MemoryStore } from '@repo/kernel/testing'
import { blocksFor, transactionKernelConfig } from '@repo/kit'
import { MAX_COST_LEVEL_AGE_MS, venuePairKey } from '@repo/swaps'
import { lensKey } from '@repo/utils'
import { executorLiquidationValidator } from '@repo/validators'
import { decodeFunctionData, getAddress, pad, zeroAddress } from 'viem'
import { base } from 'viem/chains'

import type { WhitelistSource } from '../../src/discovery/markets'
import type { Market } from '../../src/execution/encode-call'
import type { Pricing, Readings } from '../../src/liquidation'
import type { LiquidationPlan } from '../../src/sizing/plan'
import type { LensOut } from '../../src/state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { encodeLiquidationExec } from '../../src/execution/encode-call'
import { routeKeyOf } from '../../src/liquidation'
import { startLiquidator } from '../../src/run'
import { createPlanSkipLog } from '../../src/runner/plan-skip-log'
import { createTickStats } from '../../src/stats'

export const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const MIDNIGHT = getAddress('0x2222222222222222222222222222222222222222')
const ACCOUNT = getAddress('0x4444444444444444444444444444444444444444')
const ORACLE = getAddress('0x5555555555555555555555555555555555555555')
export const LOAN = getAddress('0x6666666666666666666666666666666666666666')
/** The chain's wrapped native token, which the default prices leave unpriced. */
export const NATIVE = getAddress('0x7777777777777777777777777777777777777777')
const BLOCK_MS = 40
const MARKETS_REFRESH_MS = 50
const MAX_SPEND_WEI = 10n ** 16n
const STUCK_MS = 10_000
/** How many blocks a sent transaction waits for inclusion before the kernel re-bids its nonce. */
export const STUCK_BLOCKS = blocksFor(STUCK_MS, base)
const LLTV = 860000000000000000n
const CURSOR = 250000000000000000n
const MAX_LIF = 1036269430051813471n
/** A matured position is liquidatable from the first block whose timestamp passes this. */
export const FAR_MATURITY = 10n ** 12n

/** Waits on the global timer, so a scenario under fake timers controls it. */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Markets differ only by their tag, carried in `enterGate`, which nothing here reads. */
const tagOf = (index: number) => getAddress(pad(`0x${(index + 0x1000).toString(16)}`, { size: 20 }))
/**
 * Each market sells its own collateral, so each has its own pair and curve. Slot 1 is the loan token,
 * so it sells nothing; every slot past it sells a token of its own.
 */
export const collateralAt = (index: number, slot = 0) =>
  getAddress(pad(`0x${(index + 0x2000 + slot * 0x100).toString(16)}`, { size: 20 }))
const marketOfCollateral = (collateral: Address) => Number((BigInt(collateral) - 0x2000n) % 0x100n)

export const PRICES = { [LOAN]: { priceE8: 10n ** 8n, decimals: 18 } }
export const PRICING_NOW = 1_000_000

export const keyedOf = <T>(entries: Record<string, T>): Keyed<T> => ({
  coverage: { status: 'complete' },
  keys: Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [
      key,
      { status: 'present', value, digest: key, basis: 0 } as const
    ])
  )
})

/** Readings each present until `expiry`, as a source that bounds them writes them. */
export const readingsOf = <T>(
  entries: Record<string, T>,
  expiry = Number.MAX_SAFE_INTEGER
): Readings<T> =>
  Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [
      key,
      { status: 'present', value, digest: key, basis: 0, expiry } as const
    ])
  )

/**
 * Pricing in which market 0's collateral routes through its own pair, with a curve costing `bps`
 * `ageMs` before {@link PRICING_NOW} when one is given, expiring as the curve source writes it.
 */
export const pricingFor = (curve?: { bps: number; ageMs?: number }, routed = true): Pricing => {
  const pair = { collateral: collateralAt(0), loan: LOAN }
  const updatedAt = PRICING_NOW - (curve?.ageMs ?? 0)
  return {
    prices: readingsOf(PRICES),
    routes: routed
      ? readingsOf({ [routeKeyOf(pair.collateral, LOAN)]: { pair, resolvedAt: PRICING_NOW } })
      : {},
    curves:
      curve === undefined
        ? {}
        : readingsOf(
            { [venuePairKey(pair)]: curveCosting(curve.bps, updatedAt) },
            updatedAt + MAX_COST_LEVEL_AGE_MS
          ),
    venues: ['0x']
  }
}

/** A one-venue curve whose route costs `bps` at every size it brackets. */
export const curveCosting = (bps: number, updatedAt: number): PairCurve => {
  const ladder = [10n ** 4n, 10n ** 40n]
  return {
    updatedAt,
    ladder,
    venues: [
      {
        venue: '0x',
        rungs: ladder.map(amountIn => ({
          amountIn,
          expectedOut: (amountIn * BigInt(10_000 - bps)) / 10_000n
        }))
      }
    ]
  }
}

const marketAt = (index: number, maturity = FAR_MATURITY, slots = 2): Market => ({
  chainId: 8453n,
  midnight: MIDNIGHT,
  loanToken: LOAN,
  collateralParams: Array.from({ length: slots }, (_, slot) => ({
    token: slot === 1 ? LOAN : collateralAt(index, slot),
    lltv: LLTV,
    liquidationCursor: CURSOR,
    oracle: ORACLE
  })),
  maturity,
  rcfThreshold: WAD,
  enterGate: tagOf(index),
  liquidatorGate: zeroAddress
})
export const marketIdAt = (index: number) => pad(`0x${(index + 1).toString(16)}`, { size: 32 })
export const borrowerAt = (index: number) =>
  getAddress(pad(`0x${(index + 0x100).toString(16)}`, { size: 20 }))
export const positionKey = (market: number, borrower: Address) =>
  lensKey(marketIdAt(market), borrower)

/**
 * One borrower in one market: its activated collateral slots, each liquidated whole, and whether it
 * is unhealthy before maturity, rather than liquidatable only once its market matures.
 */
export type Position = {
  market: number
  borrower: Address
  slots: number[]
  unhealthy: boolean
  /** Collateral per slot, in whole tokens priced at one loan token; 100 by default. */
  amount?: bigint
  /** Collateral of the slots named, overriding `amount`. */
  amounts?: Readonly<Record<number, bigint>>
  /** Whether its bad debt covers its whole debt, so it is written off rather than liquidated. */
  writeOff?: boolean
}

export const outAt = (position: Position, timestamp: bigint, maturity: bigint): LensOut => ({
  valid: true,
  hasDebt: true,
  healthy: !position.unhealthy,
  locked: false,
  gateAllows: true,
  blockTimestamp: timestamp,
  debt: 1_000n * WAD,
  maxDebt: position.unhealthy ? 900n * WAD : 2_000n * WAD,
  badDebt: position.writeOff ? 1_000n * WAD : 0n,
  activatedBitmap: position.slots.reduce((bits, slot) => bits | (1n << BigInt(slot)), 0n),
  collaterals: position.slots.map(index => ({
    index,
    amt: (position.amounts?.[index] ?? position.amount ?? 100n) * WAD,
    price: ORACLE_PRICE_SCALE,
    maxLif: MAX_LIF,
    lltv: LLTV
  })),
  market: marketAt(position.market, maturity, Math.max(1, ...position.slots) + 1)
})

const swap: SwapPlan = { steps: [], expectedAmountOut: 10n ** 30n, amountOutMinimum: 1n }

/** The position and slot a mined Executor call liquidates. */
const liquidated = (payload: TxPayload) => {
  if (payload.to !== EXECUTOR) return undefined
  const exec = decodeFunctionData({ abi: Executor.abi, data: payload.data as Hex })
  const [first] = (exec.args as readonly [readonly Hex[]])[0]
  const call = decodeFunctionData({ abi: Executor.abi, data: first! })
  const liquidate = decodeFunctionData({
    abi: MidnightAbi,
    data: (call.args as readonly unknown[])[3] as Hex
  })
  const [market, index, , , borrower] = liquidate.args as unknown as readonly [
    Market,
    bigint,
    bigint,
    bigint,
    Address
  ]
  const tag = Number(BigInt(market.enterGate) - 0x1000n)
  return { key: positionKey(tag, borrower), slot: Number(index) }
}

type Line = Readonly<{ event: string; fields: Record<string, unknown> }>

const recordingLogger = (lines: Line[], failsOn: () => string | undefined): Logger => {
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    if (event === failsOn()) throw new Error(`the logger failed on ${event}`)
    lines.push({ event, fields })
  }
  return { debug: log, info: log, warn: log, error: log }
}

const kernelConfig = (reservations: number): KernelConfig => {
  const config = transactionKernelConfig(
    {
      chainId: 8453,
      targets: [EXECUTOR],
      maxSpendWei: MAX_SPEND_WEI,
      stuckMs: STUCK_MS,
      maxEvidenceAgeBlocks: 64
    },
    base,
    ACCOUNT,
    executorLiquidationValidator({
      executor: EXECUTOR,
      protocol: { kind: 'midnight', midnight: MIDNIGHT }
    })
  )
  return { ...config, caps: { native: BigInt(reservations) * MAX_SPEND_WEI } }
}

export const until = async (done: () => boolean, what: string, ms = 20_000) => {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

const discardingJournal = {
  sink: { append: async () => {}, finalize: async () => {} },
  capacityBytes: 1_000_000
}

/**
 * The liquidator against a fake chain. `alive` holds the positions discovery returns; one is
 * liquidatable once unhealthy, or once a block's timestamp passes `world.maturity`. A mined
 * liquidation seizes its slot whole and retires the position with its last slot, unless `squeeze`
 * says the shared route is spent.
 */
// oxlint-disable-next-line complexity
export const startBot = async (
  parameters: {
    chain?: FakeChain
    store?: MemoryStore
    alive?: Map<string, Position>
    enrollment?: 'enrolling' | 'enrolled'
    reservations?: number
    concurrency?: number
    /** How long each firm quote takes, as a venue's latency would. */
    quoteMs?: number
    /** Answers each firm quote, after it is recorded, in place of the world's switches. */
    quote?: (plan: LiquidationPlan, key: string) => Promise<QuoteOutcome>
    /** How many preparations may start in a window, as `HTTP_RPS` sets it in production. */
    venueBudget?: Budget
    /** How often the miner mines a block once mining. */
    blockMs?: number
    markets?: number
    maturity?: bigint
    /** How long the whitelist holds without a refresh landing. */
    maxAgeMs?: number
    runId?: string
    squeeze?: (indexInBlock: number) => boolean
    /** Each market's route cost on a trusted curve, in bps; unset leaves every route unknown. */
    routeCostBps?: (market: number) => number
    backoffBlocks?: number
    /** Whether prices refreshes find no price for any token from the start. */
    unpriced?: boolean
    pricesRefreshMs?: number
    /** How long a fetched price table orders work. */
    pricesValidMs?: number
    /** The clock the kernel, the runner and every source share. */
    now?: () => number
    worldValidMs?: number
    /** How long a prepared liquidation's quote authorizes its send; Base's by default. */
    sendLifeMs?: number
    journal?: NonNullable<RunnerOptions['journal']>
  } = {}
) => {
  const now = parameters.now ?? Date.now
  const chain = parameters.chain ?? new FakeChain()
  const store = parameters.store ?? new MemoryStore()
  const alive = parameters.alive ?? new Map<string, Position>()
  const reservations = parameters.reservations ?? 4
  const lines: Line[] = []
  const world: {
    maturity: bigint
    listed: Set<number>
    discoverFails: boolean
    quoteFails: boolean
    /** While set, every firm quote misses its floor, which declines without backing off. */
    quotesShort: boolean
    /** While set, a prices refresh finds no price for any token. */
    unpriced: boolean
    /** While set, a prices refresh fails and the source keeps its last table, as the API source does. */
    pricesDown: boolean
    logFailsOn?: string
    /** While set, a markets refresh fails and the whitelist keeps its last good sources. */
    marketsDown: boolean
    /** While set, a markets refresh throws. */
    marketsThrow: boolean
    quotes: number
    /** The position of every firm quote asked for, in order. */
    quotedBy: string[]
    /** While set, route resolution waits on it, as a stalled RPC would. */
    routesHeld?: Promise<void>
    routeResolves: number
    /** While set, curve sweeps wait on it. */
    sweepsHeld?: Promise<void>
    /** When the curves were last swept; now, unless a test ages them. */
    curvesAt?: number
  } = {
    maturity: parameters.maturity ?? FAR_MATURITY,
    listed: new Set(Array.from({ length: parameters.markets ?? 1 }, (_, index) => index)),
    discoverFails: false,
    quoteFails: false,
    quotesShort: false,
    unpriced: parameters.unpriced ?? false,
    pricesDown: false,
    marketsDown: false,
    marketsThrow: false,
    quotes: 0,
    quotedBy: [],
    routeResolves: 0
  }
  const minedInBlock = new Map<number, number>()
  chain.onMined = (payload, block) => {
    const target = liquidated(payload)
    if (!target) return 'success'
    const index = minedInBlock.get(block) ?? 0
    minedInBlock.set(block, index + 1)
    const position = alive.get(target.key)
    if (!position?.slots.includes(target.slot) || parameters.squeeze?.(index)) return 'reverted'
    position.slots = position.slots.filter(slot => slot !== target.slot)
    if (position.slots.length === 0) alive.delete(target.key)
    return 'success'
  }
  let lastPrices = { table: {}, updatedAt: null as number | null }
  let lastGood: WhitelistSource[] = []
  const sources = (): WhitelistSource[] => {
    if (!world.marketsDown)
      lastGood = [
        { source: 'fake', ids: [...world.listed].map(marketIdAt).toSorted(), updatedAt: now() }
      ]
    return lastGood
  }
  const options = {
    kernel: {
      config: kernelConfig(reservations),
      store,
      chain,
      effects: chain.effects,
      enrollment: parameters.enrollment ?? 'enrolling',
      pollMs: 5,
      effectTimeoutMs: 1_000,
      reorgDepth: 16,
      onError: () => {}
    },
    world: {
      discover: async () => {
        if (world.discoverFails) throw new Error('the discovery API is down')
        return {
          candidates: [...alive.values()].map(position => ({
            marketId: marketIdAt(position.market),
            borrower: position.borrower
          })),
          complete: true
        }
      },
      readLens: async (pairs, at) => {
        const block = chain.blockAt(at.number)
        if (block.hash !== at.hash) throw new Error('no block with that hash')
        return new Map(
          pairs.flatMap(pair => {
            const key = lensKey(pair.id, pair.borrower)
            const position = alive.get(key)
            return position && position.slots.length > 0
              ? [[key, outAt(position, block.timestamp, world.maturity)] as const]
              : []
          })
        )
      },
      caller: EXECUTOR
    },
    worldValidMs: parameters.worldValidMs ?? 60_000,
    prepare: {
      executor: EXECUTOR,
      minSurplusBps: 0,
      quoteFor: async (plan, _out, key) => {
        world.quotes += 1
        world.quotedBy.push(key)
        if (parameters.quote) return parameters.quote(plan, key)
        if (parameters.quoteMs) await sleep(parameters.quoteMs)
        if (world.quoteFails) throw new Error('the venue is down')
        if (world.quotesShort) return { kind: 'failed', reason: 'floor_unmet', firmCalls: 1 }
        return { kind: 'swap', plan: swap, firmCalls: 1 }
      },
      encode: (market, borrower, plan, swapPlan) =>
        encodeLiquidationExec({
          executor: EXECUTOR,
          midnight: MIDNIGHT,
          market,
          collateralIndex: plan.collateralIndex,
          seizedAssets: plan.seizedAssets,
          repaidUnits: plan.repaidUnits,
          borrower,
          postMaturityMode: plan.postMaturityMode,
          plan: swapPlan,
          recipient: ACCOUNT
        }),
      simulate: async () => ({ status: 'ok' }),
      feesFor: async () => ({
        l1Data: 0n,
        baseFee: 0n,
        gasLimit: 0n,
        firstBid: () => ({ maxFeePerGas: 0n, gas: 0n })
      }),
      nativeToken: NATIVE,
      validForMs: parameters.sendLifeMs ?? 40_000,
      now
    },
    sizing: { seizeCapMarginBps: 0, headroomFloorBps: 0 },
    markets: {
      initial: sources(),
      maxAgeMs: parameters.maxAgeMs ?? 60_000,
      refreshMs: MARKETS_REFRESH_MS,
      refresh: async () => {
        if (world.marketsThrow) throw new Error('the markets API is down')
        return sources()
      }
    },
    prices: {
      refreshMs: parameters.pricesRefreshMs ?? 60_000,
      validForMs: parameters.pricesValidMs ?? 300_000,
      refresh: async () => {
        if (!world.pricesDown)
          lastPrices = { table: world.unpriced ? {} : PRICES, updatedAt: now() }
        return lastPrices
      }
    },
    routes: parameters.routeCostBps
      ? {
          resolvePair: async (collateral, loan) => {
            world.routeResolves += 1
            await world.routesHeld
            return { collateral, loan }
          },
          sweep: async () => {
            await world.sweepsHeld
          },
          curveOf: pair =>
            curveCosting(
              parameters.routeCostBps!(marketOfCollateral(pair.collateral)),
              world.curvesAt ?? now()
            ),
          venues: ['0x']
        }
      : {
          resolvePair: async () => null,
          sweep: async () => {},
          curveOf: () => undefined,
          venues: []
        },
    venue: {
      concurrency: parameters.concurrency ?? 4,
      ...(parameters.venueBudget && { budget: parameters.venueBudget })
    },
    backoff: {
      baseBlocks: parameters.backoffBlocks ?? 1,
      maxBlocks: parameters.backoffBlocks ?? 4
    },
    runId: parameters.runId ?? 'run',
    maxReservations: reservations,
    stats: createTickStats(),
    planSkipLog: createPlanSkipLog(),
    logger: recordingLogger(lines, () => world.logFailsOn)
  } satisfies Omit<Parameters<typeof startLiquidator>[0], 'journal'>
  const bot = await startLiquidator({
    ...options,
    now,
    journal: parameters.journal ?? discardingJournal
  })
  const state = () => bot.runner.read(bot.nodes.kernel.nodes.state)!
  let miner: ReturnType<typeof setInterval> | undefined
  const mining = (on: boolean) => {
    clearInterval(miner)
    miner = on ? setInterval(() => chain.mine(), parameters.blockMs ?? BLOCK_MS) : undefined
  }
  return {
    ...bot,
    options,
    chain,
    store,
    alive,
    lines,
    world,
    state,
    mining,
    events: (event: string) => lines.filter(line => line.event === event),
    shutdown: async () => {
      mining(false)
      await bot.runner.abandon()
    }
  }
}

/** A position in `market` that is unhealthy now, across the given slots. */
export const unhealthy = (market: number, index: number, slots = [0]): Position => ({
  market,
  borrower: borrowerAt(index),
  slots,
  unhealthy: true
})
