import type { Logger } from '@repo/kit'
import type { Address, Hex } from 'viem'

import { MarketUtils } from '@morpho-org/blue-sdk'
import { MetaMorphoAction } from '@morpho-org/blue-sdk-viem'
import { FakeChain, MemoryStore } from '@repo/kernel/testing'
import { transactionKernelConfig } from '@repo/kit'
import { vaultV1ReallocationValidator } from '@repo/validators'
import { setTimeout as sleep } from 'node:timers/promises'
import { getAddress, maxUint256, pad, zeroAddress } from 'viem'

import type { MarketAllocation, Strategy } from '../../src/strategies'
import type { VaultData } from '../../src/vault-data'

import { startReallocator } from '../../src/run'

const ACCOUNT = getAddress('0x4444444444444444444444444444444444444444')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const BLOCK_MS = 40
const MAX_SPEND_WEI = 10n ** 16n
const HELD = 100n * 10n ** 18n
const CAP = 10n ** 24n

export const vaultAt = (index: number) =>
  getAddress(pad(`0x${(index + 0x100).toString(16)}`, { size: 20 }))

const lending = {
  loanToken: LOAN,
  collateralToken: COLLATERAL,
  oracle: ACCOUNT,
  irm: ACCOUNT,
  lltv: 86n * 10n ** 16n
}
const idle = {
  loanToken: LOAN,
  collateralToken: zeroAddress,
  oracle: zeroAddress,
  irm: zeroAddress,
  lltv: 0n
}

const marketData = (params: typeof lending, vaultAssets: bigint) => ({
  id: MarketUtils.getMarketId(params) as Hex,
  params,
  state: { totalSupplyAssets: 10n ** 21n, totalBorrowAssets: 9n * 10n ** 20n },
  cap: CAP,
  vaultAssets,
  rateAtTarget: 10n ** 9n,
  isAdaptiveCurve: true,
  isIdle: params.collateralToken === zeroAddress
})

/** An unbalanced vault holds everything in its lending market; a balanced one holds half in idle. */
const vaultData = (vault: Address, roled: boolean, unbalanced: boolean): VaultData => ({
  vaultAddress: vault,
  owner: zeroAddress,
  curator: zeroAddress,
  isAllocator: roled,
  marketsData: unbalanced
    ? [marketData(lending, HELD), marketData(idle, 0n)]
    : [marketData(lending, HELD / 2n), marketData(idle, HELD / 2n)],
  nonAdaptiveCurveMarketIds: []
})

/** Moves half the vault's lending position to its idle market. */
const rebalance: MarketAllocation[] = [
  { marketParams: lending, assets: HELD / 2n },
  { marketParams: idle, assets: maxUint256 }
]

/** Rebalances a vault whose read shows everything in its lending market, and nothing else. */
const strategy: Strategy = data =>
  data.marketsData[0]?.vaultAssets === HELD ? rebalance : undefined

type Journal = Parameters<typeof startReallocator>[0]['journal']

/** A journal that keeps what it is handed, and how it was finalized. */
export const recordingJournal = () => {
  const finalized: (Readonly<{ clean?: boolean }> | undefined)[] = []
  const journal: Journal = {
    sink: {
      append: async () => {},
      finalize: async (_signal, result) => {
        finalized.push(result)
      }
    },
    capacityBytes: 1_000_000
  }
  return { journal, finalized }
}

type Line = Readonly<{ event: string; fields: Record<string, unknown> }>

const recordingLogger = (lines: Line[]): Logger => {
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    lines.push({ event, fields })
  }
  return { debug: log, info: log, warn: log, error: log }
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
 * The reallocator against a fake chain: `vaults` is the whitelist, a vault in `unbalanced` has a
 * reallocation its strategy wants, and a mined reallocation balances its vault.
 */
export const startBot = async (
  parameters: {
    vaults?: readonly Address[]
    chain?: FakeChain
    store?: MemoryStore
    unbalanced?: Set<Address>
    intervalMs?: number
    dryRun?: boolean
    simulateReverts?: boolean
    unroled?: readonly Address[]
    journal?: Journal
    runId?: string
    enrollment?: 'enrolling' | 'enrolled'
    /** The clock the kernel, the runner and preparations share. */
    now?: () => number
  } = {}
) => {
  const chain = parameters.chain ?? new FakeChain()
  const store = parameters.store ?? new MemoryStore()
  const vaults = parameters.vaults ?? [vaultAt(1), vaultAt(2)]
  const unbalanced = parameters.unbalanced ?? new Set<Address>()
  const lines: Line[] = []
  const world = {
    reads: 0,
    /** When each read reached the lens, by the wall clock. */
    readAt: [] as number[],
    /** How long each read takes, and the most reads that were ever in flight at once. */
    readDelayMs: 0,
    reading: 0,
    mostReading: 0,
    readFails: false,
    simulateReverts: parameters.simulateReverts ?? false,
    unserved: new Set<Address>(),
    unroled: new Set<Address>(parameters.unroled),
    /** What each simulation waits on before it answers, and how many have started. */
    simulateGate: Promise.resolve(),
    simulations: 0
  }
  chain.onMined = payload => {
    const vault = getAddress(payload.to)
    if (!unbalanced.has(vault)) return 'reverted'
    unbalanced.delete(vault)
    return 'success'
  }
  const validator = vaultV1ReallocationValidator({ vaults })
  const limits = {
    chainId: 8453,
    targets: vaults,
    maxSpendWei: MAX_SPEND_WEI,
    stuckBlocks: 5,
    maxEvidenceAgeBlocks: 64
  }
  const bot = await startReallocator({
    journal: parameters.journal ?? discardingJournal,
    kernel: {
      config: transactionKernelConfig(limits, ACCOUNT, validator),
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
      vaults,
      fetchVaults: async (read, blockHash) => {
        world.reads += 1
        world.readAt.push(Date.now())
        world.reading += 1
        world.mostReading = Math.max(world.mostReading, world.reading)
        await sleep(world.readDelayMs)
        world.reading -= 1
        if (world.readFails) throw new Error('the lens reverted')
        if (Number(blockHash) > chain.height) throw new Error('no block with that hash')
        return new Map(
          read
            .filter(vault => !world.unserved.has(vault))
            .map(vault => [
              vault.toLowerCase(),
              vaultData(vault, !world.unroled.has(vault), unbalanced.has(vault))
            ])
        )
      }
    },
    strategy,
    eoa: ACCOUNT,
    prepare: {
      encode: allocations => MetaMorphoAction.reallocate([...allocations]),
      simulate: async () => {
        world.simulations += 1
        await world.simulateGate
        return world.simulateReverts
          ? { status: 'revert', reason: 'SupplyCapExceeded' }
          : { status: 'ok' }
      },
      dryRun: parameters.dryRun ?? false,
      validForMs: 60_000,
      now: parameters.now ?? Date.now
    },
    intervalMs: parameters.intervalMs ?? 20,
    backoff: { baseBlocks: 1, maxBlocks: 4 },
    runId: parameters.runId ?? 'run',
    maxReservations: 4,
    feesOf: () => ({ maxFeePerGasWei: 7n, priorityFeePerGasWei: 3n }),
    logger: recordingLogger(lines),
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
    unbalanced,
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
