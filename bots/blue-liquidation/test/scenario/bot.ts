import type { BackoffPolicy } from '@repo/controller'
import type { Budget } from '@repo/engine'
import type { KernelConfig, TxPayload } from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { SwapPlan } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { Executor, MorphoAbi } from '@repo/contracts'
import { FakeChain, MemoryStore } from '@repo/kernel/testing'
import { transactionKernelConfig } from '@repo/kit'
import { lensKey } from '@repo/utils'
import { executorLiquidationValidator } from '@repo/validators'
import { setTimeout as sleep } from 'node:timers/promises'
import { decodeFunctionData, getAddress, pad } from 'viem'
import { base } from 'viem/chains'

import type { MarketParams } from '../../src/market'
import type { LensOut } from '../../src/state/lens.sol'

import { encodeLiquidationExec } from '../../src/execution/encode-call'
import { marketId } from '../../src/market'
import { startLiquidator } from '../../src/run'
import { createTickStats } from '../../src/stats'

export const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')
const MORPHO = getAddress('0x2222222222222222222222222222222222222222')
const ACCOUNT = getAddress('0x4444444444444444444444444444444444444444')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const BLOCK_MS = 40
const MAX_SPEND_WEI = 10n ** 16n

export const market: MarketParams = {
  loanToken: LOAN,
  collateralToken: COLLATERAL,
  oracle: ACCOUNT,
  irm: ACCOUNT,
  lltv: 86n * 10n ** 16n
}
export const MARKET_ID = marketId(market)

export const borrowerAt = (index: number) =>
  getAddress(pad(`0x${(index + 0x100).toString(16)}`, { size: 20 }))
export const positionKey = (borrower: Address) => lensKey(MARKET_ID, borrower)

/**
 * An unhealthy position whose debt accrues every block, so its lens reading always moves, and whose
 * collateral each of its `liquidations` seized from.
 */
const unhealthyAt = (block: bigint, liquidations: number, cut: bigint): LensOut => ({
  valid: true,
  hasDebt: true,
  healthy: false,
  blockTimestamp: block * 2n,
  borrowShares: 10n ** 24n,
  collateral: 10n ** 18n - BigInt(liquidations) * 10n ** 16n - cut,
  accruedTotalBorrowAssets: 10n ** 18n + block,
  totalBorrowShares: 10n ** 24n,
  collateralPrice: 10n ** 36n,
  lltv: market.lltv,
  params: market
})

const swap: SwapPlan = { steps: [], expectedAmountOut: 10n ** 18n, amountOutMinimum: 1n }

const borrowerOf = (payload: TxPayload): Address | undefined => {
  if (payload.to !== EXECUTOR) return undefined
  const exec = decodeFunctionData({ abi: Executor.abi, data: payload.data as Hex })
  const [first] = (exec.args as readonly [readonly Hex[]])[0]
  const call = decodeFunctionData({ abi: Executor.abi, data: first! })
  const liquidate = decodeFunctionData({
    abi: MorphoAbi,
    data: (call.args as readonly unknown[])[3] as Hex
  })
  return (liquidate.args as readonly unknown[])[1] as Address
}

type Line = Readonly<{ event: string; fields: Record<string, unknown> }>

/** Records every line, and throws on the event `failsOn` names, as a broken log transport would. */
const recordingLogger = (lines: Line[], failsOn: () => string | undefined): Logger => {
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    if (event === failsOn()) throw new Error(`the logger failed on ${event}`)
    lines.push({ event, fields })
  }
  return { debug: log, info: log, warn: log, error: log }
}

export const kernelConfig = (reservations: number): KernelConfig => {
  const config = transactionKernelConfig(
    {
      chainId: 8453,
      targets: [EXECUTOR],
      maxSpendWei: MAX_SPEND_WEI,
      stuckMs: 10_000,
      maxEvidenceAgeBlocks: 64
    },
    base,
    ACCOUNT,
    executorLiquidationValidator({ executor: EXECUTOR, protocol: { kind: 'blue', morpho: MORPHO } })
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
 * The liquidator against a fake chain: `alive` are the positions the world reads as liquidatable,
 * and a mined liquidation clears its position unless `squeeze` says the shared route is spent or
 * `survives` says it stays liquidatable.
 */
export const startBot = async (
  parameters: {
    chain?: FakeChain
    store?: MemoryStore
    alive?: Set<Address>
    enrollment?: 'enrolling' | 'enrolled'
    reservations?: number
    runId?: string
    /** Whether a liquidation mined at this index of its block reverts. */
    squeeze?: (indexInBlock: number) => boolean
    /** How many of its liquidations each position stays liquidatable after. */
    survives?: Map<Address, number>
    /** The clock the kernel and the runner share. */
    now?: () => number
    worldValidMs?: number
    backoff?: BackoffPolicy
    /** Firm quotes the venue starts per window, when it is rate limited. */
    venueBudget?: Budget
    /** The kernel's block windows, when not the default small ones. */
    windows?: Readonly<{
      maxSimLagBlocks: number
      maxEvidenceAgeBlocks: number
      reorgDepth: number
    }>
  } = {}
) => {
  const chain = parameters.chain ?? new FakeChain()
  const store = parameters.store ?? new MemoryStore()
  const alive = parameters.alive ?? new Set<Address>()
  const reservations = parameters.reservations ?? 4
  const lines: Line[] = []
  const world: {
    discoverFails: boolean
    quoteFails: boolean
    /** A quote in flight answers only once this settles. */
    quoteHeld?: Promise<void>
    /** A simulation answers only once this settles. */
    simulateHeld?: Promise<void>
    /** Collateral every position has lost besides its liquidations, which shrinks its seize. */
    collateralCut: bigint
    simulateThrows: boolean
    /** How many quotes the venue was asked for. */
    quotes: number
    logFailsOn?: string
    /** How long a lens read takes to answer. */
    readDelayMs: number
  } = {
    discoverFails: false,
    quoteFails: false,
    collateralCut: 0n,
    simulateThrows: false,
    quotes: 0,
    readDelayMs: 0
  }
  const liquidated = new Map<Address, number>()
  const minedInBlock = new Map<number, number>()
  chain.onMined = (payload, block) => {
    const borrower = borrowerOf(payload)
    if (!borrower) return 'success'
    const index = minedInBlock.get(block) ?? 0
    minedInBlock.set(block, index + 1)
    if (!alive.has(borrower) || parameters.squeeze?.(index)) return 'reverted'
    liquidated.set(borrower, (liquidated.get(borrower) ?? 0) + 1)
    const survives = parameters.survives?.get(borrower) ?? 0
    if (survives > 0) parameters.survives!.set(borrower, survives - 1)
    else alive.delete(borrower)
    return 'success'
  }
  const bot = await startLiquidator({
    journal: discardingJournal,
    kernel: {
      config: {
        ...kernelConfig(reservations),
        ...(parameters.windows && {
          maxSimLagBlocks: parameters.windows.maxSimLagBlocks,
          maxEvidenceAgeBlocks: parameters.windows.maxEvidenceAgeBlocks
        })
      },
      store,
      chain,
      effects: chain.effects,
      enrollment: parameters.enrollment ?? 'enrolling',
      pollMs: 5,
      effectTimeoutMs: 1_000,
      reorgDepth: parameters.windows?.reorgDepth ?? 16,
      onError: () => {}
    },
    world: {
      discover: async () => {
        if (world.discoverFails) throw new Error('the discovery API is down')
        return {
          candidates: [...alive].map(borrower => ({ marketParams: market, borrower })),
          complete: true
        }
      },
      readLens: async (pairs, at) => {
        if (chain.blockAt(at.number).hash !== at.hash) throw new Error('no block with that hash')
        if (world.readDelayMs > 0) await sleep(world.readDelayMs)
        return new Map(
          pairs
            .filter(pair => alive.has(pair.borrower))
            .map(
              pair =>
                [
                  positionKey(pair.borrower),
                  unhealthyAt(
                    BigInt(at.number),
                    liquidated.get(pair.borrower) ?? 0,
                    world.collateralCut
                  )
                ] as const
            )
        )
      }
    },
    worldValidMs: parameters.worldValidMs ?? 60_000,
    quotes: {
      quoteFor: async () => {
        world.quotes += 1
        await world.quoteHeld
        if (world.quoteFails) throw new Error('the venue is down')
        return { kind: 'swap', plan: swap }
      },
      validForMs: 60_000,
      retryMs: 1_000
    },
    prepare: {
      executor: EXECUTOR,
      encode: (marketArg, borrower, seizedAssets, swapPlan) =>
        encodeLiquidationExec({
          executor: EXECUTOR,
          morpho: MORPHO,
          market: marketArg,
          seizedAssets,
          borrower,
          plan: swapPlan,
          recipient: ACCOUNT
        }),
      simulate: async () => {
        await world.simulateHeld
        if (world.simulateThrows) throw new Error('the node is down')
        return { status: 'ok' }
      }
    },
    venue: { concurrency: 4, ...(parameters.venueBudget && { budget: parameters.venueBudget }) },
    simulations: 4,
    backoff: parameters.backoff ?? { baseBlocks: 1, maxBlocks: 4 },
    runId: parameters.runId ?? 'run',
    maxReservations: reservations,
    stats: createTickStats(),
    logger: recordingLogger(lines, () => world.logFailsOn),
    ...(parameters.now && { now: parameters.now })
  })
  const state = () => bot.runner.read(bot.nodes.kernel.nodes.state)!
  let miner: ReturnType<typeof setInterval> | undefined
  const mining = (on: boolean) => {
    clearInterval(miner)
    miner = on ? setInterval(() => chain.mine(), BLOCK_MS) : undefined
  }
  return {
    ...bot,
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
