import type { KernelState } from '@repo/kernel'

import { getAddress } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'

import type { MarketId } from '../../src/domain/order-book'

import { crossedBook, marketAt, RESOLVER, resolutionOf, startBot, until } from './bot'

type Bot = Awaited<ReturnType<typeof startBot>>

const bots: Bot[] = []
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.shutdown()
})

const started = async (parameters: Parameters<typeof startBot>[0] = {}) => {
  const bot = await startBot(parameters)
  bots.push(bot)
  await until(() => bot.state().lifecycle.kind === 'running', 'the kernel running')
  return bot
}

const candidatesOf = (state: KernelState, market: MarketId) =>
  Object.values(state.nonces).flatMap(record =>
    record.candidates.filter(candidate => candidate.intentId.startsWith(`${market}#`))
  )
const scans = (bot: Bot) => bot.events('tick.end').length
const afterScans = async (bot: Bot, count: number) => {
  const target = scans(bot) + count
  await until(() => scans(bot) >= target, `${count} more scans`)
}

describe('the crossed-books resolver on the engine', () => {
  it('sends exactly the resolution it simulated to the resolver, once per crossing', async () => {
    const bot = await started()
    const market = marketAt(1)
    const book = crossedBook(market)
    bot.books.set(market, book)
    bot.mining(true)

    await until(() => bot.books.size === 0, 'the crossing to resolve')
    await afterScans(bot, 3)

    expect(bot.mined).toStrictEqual([
      { kind: 'tx', to: RESOLVER, data: resolutionOf(book), value: 0n }
    ])
    expect(bot.events('kernel.alarm')).toStrictEqual([])
  })

  it('never sends a crossing whose resolution does not simulate', async () => {
    const bot = await started()
    const market = marketAt(2)
    bot.books.set(market, crossedBook(market))
    bot.reverts.add(market)
    bot.mining(true)

    await afterScans(bot, 5)

    expect(bot.chain.signed).toStrictEqual([])
    expect(candidatesOf(bot.state(), market)).toStrictEqual([])
  })

  it('holds one resolution in flight at a time, and sends the next once it lands', async () => {
    const bot = await started()
    const [a, b] = [marketAt(3), marketAt(4)]
    bot.books.set(a, crossedBook(a))
    bot.books.set(b, crossedBook(b))
    bot.mining(true, false)

    await until(() => bot.chain.signed.length === 1, 'the first send')
    await afterScans(bot, 5)
    const sent = [a, b].filter(market => candidatesOf(bot.state(), market).length > 0)
    expect(sent.length).toBe(1)
    expect(Object.keys(bot.state().nonces)).toStrictEqual(['0'])

    bot.mining(true)
    await until(() => bot.books.size === 0, 'both crossings to resolve')
    expect(bot.mined.map(payload => payload.data).toSorted()).toStrictEqual(
      [resolutionOf(crossedBook(a)), resolutionOf(crossedBook(b))].toSorted()
    )
  })

  it('cancels a resolution not included within its window, though its books stay crossed', async () => {
    const bot = await started({ worldValidMs: 500 })
    const market = marketAt(9)
    bot.books.set(market, crossedBook(market))
    bot.mining(true, false)

    await until(() => bot.chain.signed.length === 1, 'the resolution sent')
    const [plan] = Object.values(bot.state().plans)
    expect(plan?.validUntil).toBeLessThanOrEqual(Date.now() + 500)
    await until(() => {
      const state = bot.state()
      return (
        Object.keys(state.entries).length === 0 &&
        Object.values(state.nonces).some(record =>
          record.candidates.some(candidate => candidate.payload.to !== RESOLVER)
        )
      )
    }, 'the resolution withdrawn and its nonce filled')
    expect(bot.books.has(market)).toBe(true)
  }, 30_000)

  it('signs nothing for a crossing its validator refuses, though it simulates', async () => {
    const bot = await started()
    const market = marketAt(5)
    const elsewhere = getAddress('0x2222222222222222222222222222222222222222')
    bot.books.set(market, crossedBook(market, elsewhere))
    bot.mining(true)

    await until(() => bot.events('act.submitted').length > 0, 'the act')
    await afterScans(bot, 5)

    expect(bot.chain.signed).toStrictEqual([])
    expect(bot.books.has(market)).toBe(true)
  })

  it('signs nothing the kernel finds no longer simulates at its own head', async () => {
    const bot = await started({
      effects: chain => ({ ...chain.effects, simulate: async () => false })
    })
    const market = marketAt(6)
    bot.books.set(market, crossedBook(market))
    bot.mining(true)

    await until(() => bot.events('act.submitted').length > 0, 'the act')
    await afterScans(bot, 5)

    expect(bot.chain.signed).toStrictEqual([])
    expect(bot.books.has(market)).toBe(true)
  })

  it('sends the new bytes when a scan recomputes a crossing before its act is signed', async () => {
    const bot = await started()
    const market = marketAt(8)
    const signing = bot.chain.holdSigning()
    bot.books.set(market, crossedBook(market))
    bot.mining(true, false)
    await until(() => bot.events('act.submitted').length > 0, 'the first act')

    const moved = crossedBook(market)
    const recomputed = { ...moved, asks: [{ ...moved.asks[0]!, units: 2n }] }
    bot.books.set(market, recomputed)
    await afterScans(bot, 2)
    signing.open()
    bot.mining(true)

    await until(() => bot.books.size === 0, 'the crossing to resolve')
    expect(bot.mined.map(payload => payload.data)).toStrictEqual([resolutionOf(recomputed)])
  })

  it('keeps a send in flight through a failed market list, and settles it', async () => {
    const bot = await started()
    const market = marketAt(7)
    bot.books.set(market, crossedBook(market))
    bot.mining(true, false)
    await until(() => bot.chain.signed.length === 1, 'the send')

    bot.world.listFails = true
    await until(
      () => bot.runner.read(bot.nodes.markets)?.coverage.status === 'failed',
      'the failed scan'
    )
    bot.mining(true)

    await until(() => bot.books.size === 0, 'the crossing to resolve')
    expect(bot.mined.map(payload => payload.data)).toStrictEqual([
      resolutionOf(crossedBook(market))
    ])
  })
})
