import type { Logger } from '@repo/kit'
import type { Address, Hex } from 'viem'

import { MarketUtils } from '@morpho-org/blue-sdk'
import { FakeChain, MemoryStore } from '@repo/kernel/testing'
import { transactionKernelConfig } from '@repo/kit'
import { vaultV2ReallocationValidator } from '@repo/validators'
import { setTimeout as sleep } from 'node:timers/promises'
import { getAddress, pad } from 'viem'

import type { Reallocation, Strategy } from '../../src/strategies'
import type { CapState, VaultV2Data, VaultV2Result } from '../../src/vault-data'

import { encodeReallocation } from '../../src/encode'
import { startReallocator } from '../../src/run'

const ACCOUNT = getAddress('0x4444444444444444444444444444444444444444')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const BLOCK_MS = 40
const MAX_SPEND_WEI = 10n ** 16n
const HELD = 100n * 10n ** 18n
const WAD = 10n ** 18n

export const vaultAt = (index: number) =>
  getAddress(pad(`0x${(index + 0x100).toString(16)}`, { size: 20 }))
const adapterOf = (vault: Address) =>
  getAddress(pad(`0x${(BigInt(vault) + 0x1000n).toString(16)}`, { size: 20 }))

const paramsAt = (collateral: number) => ({
  loanToken: LOAN,
  collateralToken: getAddress(pad(`0x${(0x7000 + collateral).toString(16)}`, { size: 20 })),
  oracle: ACCOUNT,
  irm: ACCOUNT,
  lltv: 86n * 10n ** 16n
})
const [hot, cold] = [paramsAt(1), paramsAt(2)]
const open = (allocation: bigint): CapState => ({ absolute: 10n ** 30n, relative: WAD, allocation })

const marketData = (params: typeof hot, vaultAssets = HELD) => ({
  id: MarketUtils.getMarketId(params) as Hex,
  capId: MarketUtils.getMarketId(params) as Hex,
  params,
  state: { totalSupplyAssets: 10n ** 21n, totalBorrowAssets: 9n * 10n ** 20n },
  cap: open(HELD),
  vaultAssets,
  shares: { vault: vaultAssets * 1_000_000n, total: 10n ** 21n * 1_000_000n },
  rateAtTarget: 10n ** 9n,
  isAdaptiveCurve: true,
  isIdle: false
})

/** An unbalanced vault holds as much cold as hot; a balanced one has moved half its cold to hot. */
const vaultData = (
  vault: Address,
  roled: boolean,
  adapter: Address,
  unbalanced: boolean
): VaultV2Data => ({
  vaultAddress: vault,
  adapterAddress: adapter,
  isAllocator: roled,
  totalAssets: 2n * HELD,
  idleAssets: 0n,
  adapterCap: open(2n * HELD),
  collateralCaps: { [hot.collateralToken]: open(HELD), [cold.collateralToken]: open(HELD) },
  marketsData: unbalanced
    ? [marketData(hot), marketData(cold)]
    : [marketData(hot, (3n * HELD) / 2n), marketData(cold, HELD / 2n)],
  nonAdaptiveCurveMarketIds: []
})

/** Moves half the vault's cold position into its hot market. */
const rebalance: Reallocation = {
  deallocations: [
    { marketId: MarketUtils.getMarketId(cold), marketParams: cold, assets: HELD / 2n }
  ],
  allocations: [{ marketId: MarketUtils.getMarketId(hot), marketParams: hot, assets: HELD / 2n }]
}

/** Rebalances a vault whose read shows as much cold as hot, and nothing else. */
const strategy: Strategy = data =>
  data.marketsData[1]?.vaultAssets === HELD ? rebalance : undefined

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
  const adapters = Object.fromEntries(vaults.map(vault => [vault, adapterOf(vault)]))
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
    simulations: 0,
    /** Vaults the lens serves in a shape the bot does not support. */
    misshapen: new Set<Address>(),
    /** Vaults whose adapter the curator swapped since startup. */
    swapped: new Set<Address>()
  }
  chain.onMined = payload => {
    const vault = getAddress(payload.to)
    if (!unbalanced.has(vault)) return 'reverted'
    unbalanced.delete(vault)
    return 'success'
  }
  const validator = vaultV2ReallocationValidator({ adapters })
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
        return new Map<string, VaultV2Result>(
          read
            .filter(vault => !world.unserved.has(vault))
            .map(vault => {
              if (world.misshapen.has(vault))
                return [vault.toLowerCase(), { error: new Error('vault has two adapters') }]
              const adapter = world.swapped.has(vault) ? ACCOUNT : adapters[vault]!
              return [
                vault.toLowerCase(),
                {
                  data: vaultData(vault, !world.unroled.has(vault), adapter, unbalanced.has(vault))
                }
              ]
            })
        )
      }
    },
    strategy,
    adapters,
    prepare: {
      encode: encodeReallocation,
      simulate: async () => {
        world.simulations += 1
        await world.simulateGate
        return world.simulateReverts
          ? { status: 'revert', reason: 'AbsoluteCapExceeded' }
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
    adapters,
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
