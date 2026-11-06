import type { BackoffPolicy } from '@repo/controller'
import type { KernelConfig, KernelEffects, TxPayload } from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { Hex } from 'viem'

import { FakeChain, MemoryStore } from '@repo/kernel/testing'
import { transactionKernelConfig } from '@repo/kit'
import { crossedBooksValidator } from '@repo/validators'
import { setTimeout as sleep } from 'node:timers/promises'
import { BaseError, encodeAbiParameters, getAddress, pad } from 'viem'
import { base } from 'viem/chains'

import type { MarketId, TakeableBook, TakeableOffer } from '../../src/domain/order-book'

import { MatchingService } from '../../src/domain/matching.service'
import { ViemResolverEncoder } from '../../src/infrastructure/resolver/resolver.encoder'
import { startResolver } from '../../src/run'
import { makeOffer } from '../fixtures/offers'

export const RESOLVER = getAddress('0x1111111111111111111111111111111111111111')
/** The Midnight the offer fixtures name. */
const MIDNIGHT = getAddress('0x3333333333333333333333333333333333333333')
const ACCOUNT = getAddress('0x9999999999999999999999999999999999999999')
const BLOCK_MS = 40
const MAX_SPEND_WEI = 10n ** 16n
const MINIMUM_PROFIT = 1n

export const marketAt = (index: number): MarketId => pad(`0x${(index + 0x100).toString(16)}`)

const offerIn = (marketId: MarketId, offer: TakeableOffer, midnight: Hex): TakeableOffer => ({
  ...offer,
  marketId,
  offer: {
    ...offer.offer,
    market: { ...offer.offer.market, midnight, maturity: BigInt(marketId) }
  }
})

/** Books that cross by two ticks, on this bot's Midnight unless `midnight` says otherwise. */
export const crossedBook = (marketId: MarketId, midnight: Hex = MIDNIGHT): TakeableBook => ({
  asks: [offerIn(marketId, makeOffer('ask', 10n, 3n), midnight)],
  bids: [offerIn(marketId, makeOffer('bid', 12n, 3n), midnight)]
})

const matching = new MatchingService()
const encoder = new ViemResolverEncoder()

/** The calldata the bot computes for `book`. */
export const resolutionOf = (book: TakeableBook) =>
  encoder.encode(matching.match({ ...book, maxMatches: 10 }), MINIMUM_PROFIT)

type Line = Readonly<{ event: string; fields: Record<string, unknown> }>

const recordingLogger = (lines: Line[]): Logger => {
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    lines.push({ event, fields })
  }
  return { debug: log, info: log, warn: log, error: log }
}

const kernelConfig = (): KernelConfig => ({
  ...transactionKernelConfig(
    {
      chainId: 8453,
      targets: [RESOLVER],
      maxSpendWei: MAX_SPEND_WEI,
      stuckMs: 10_000,
      maxEvidenceAgeBlocks: 64
    },
    base,
    ACCOUNT,
    crossedBooksValidator({ resolver: RESOLVER, midnight: MIDNIGHT })
  ),
  caps: { native: 4n * MAX_SPEND_WEI }
})

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
 * The resolver against a fake chain and fake APIs: `books` are the listed markets and their takeable
 * books. A resolution simulates while its market is not in `reverts`, and a mined one of a market's
 * current books succeeds and empties them.
 */
export const startBot = async (
  parameters: {
    effects?: (chain: FakeChain) => KernelEffects
    reservations?: number
    backoff?: BackoffPolicy
    journal?: Parameters<typeof startResolver>[0]['journal']
    worldValidMs?: number
  } = {}
) => {
  const chain = new FakeChain()
  const store = new MemoryStore()
  const books = new Map<MarketId, TakeableBook>()
  const reverts = new Set<MarketId>()
  const mined: TxPayload[] = []
  const lines: Line[] = []
  const world = { listFails: false }
  const marketOf = (data: Hex) =>
    [...books].find(([, book]) => resolutionOf(book) === data.toLowerCase())?.[0]
  chain.onMined = payload => {
    mined.push(payload)
    const market = marketOf(payload.data as Hex)
    if (market === undefined) return 'reverted'
    books.delete(market)
    return 'success'
  }
  const bot = await startResolver({
    journal: parameters.journal ?? discardingJournal,
    kernel: {
      config: kernelConfig(),
      store,
      chain,
      effects: parameters.effects?.(chain) ?? chain.effects,
      enrollment: 'enrolling',
      pollMs: 5,
      effectTimeoutMs: 1_000,
      reorgDepth: 16,
      onError: () => {}
    },
    scan: {
      listMarkets: async () => {
        if (world.listFails) throw new Error('the markets API is down')
        return [...books.keys()].map(marketId => ({ marketId }))
      },
      getBook: async marketId => books.get(marketId) ?? { asks: [], bids: [] },
      simulate: async (data, at) => {
        if (chain.blockAt(at.number).hash !== at.hash) throw new Error('no block with that hash')
        const market = marketOf(data)
        if (market === undefined || reverts.has(market))
          throw new BaseError('execution reverted: NotCrossed')
        return encodeAbiParameters([{ type: 'uint256' }], [5n])
      },
      maxMatches: 10,
      minimumProfit: MINIMUM_PROFIT
    },
    resolver: RESOLVER,
    scanIntervalMs: 10,
    worldValidMs: parameters.worldValidMs ?? 60_000,
    backoff: parameters.backoff ?? { baseBlocks: 1, maxBlocks: 4 },
    runId: 'run',
    maxReservations: parameters.reservations ?? 1,
    logger: recordingLogger(lines)
  })
  const state = () => bot.runner.read(bot.nodes.kernel.nodes.state)!
  let miner: ReturnType<typeof setInterval> | undefined
  const mining = (on: boolean, include = true) => {
    clearInterval(miner)
    miner = on ? setInterval(() => chain.mine(include), BLOCK_MS) : undefined
  }
  return {
    ...bot,
    chain,
    books,
    reverts,
    mined,
    world,
    lines,
    state,
    mining,
    events: (event: string) => lines.filter(line => line.event === event),
    shutdown: async () => {
      mining(false)
      await bot.runner.abandon()
    }
  }
}
