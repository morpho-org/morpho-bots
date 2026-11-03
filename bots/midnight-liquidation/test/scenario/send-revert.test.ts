import { FakeChain } from '@repo/kernel/testing'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'

import type { Position } from './bot'

import { positionKey, startBot, unhealthy, until } from './bot'

type Bot = Awaited<ReturnType<typeof startBot>>

/**
 * A chain whose timestamps sit a few minutes into the LIF ramp of a market maturing at `MATURED`, so
 * a healthy position there has only post-maturity alternatives; one maturing far off has only
 * normal-mode ones.
 */
const HEIGHT = 1_200
const MATURED = 2_000n
/** Long enough that a position backed off once is not prepared again within a test. */
const BACKOFF_BLOCKS = 1_000

const bots: Bot[] = []
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.shutdown()
})

/** A bot whose kernel simulations answer `simulate`, counting each one. */
const started = async (
  simulate: () => Promise<boolean>,
  parameters: Readonly<{ maturity?: bigint; squeeze?: () => boolean }> = {}
) => {
  const chain = new FakeChain()
  chain.height = HEIGHT
  const simulations = { count: 0, answer: simulate }
  chain.effects.simulate = () => {
    simulations.count += 1
    return simulations.answer()
  }
  const bot = await startBot({ chain, backoffBlocks: BACKOFF_BLOCKS, ...parameters })
  bots.push(bot)
  await until(() => bot.state().lifecycle.kind === 'running', 'the kernel running')
  return { bot, simulations }
}

const keyOf = (position: Position) => positionKey(position.market, position.borrower)
const matured = (index: number): Position => ({ ...unhealthy(0, index), unhealthy: false })
const backoffOf = (bot: Bot, position: Position) =>
  bot.runner.read(bot.nodes.backoff.state)?.keys[keyOf(position)]?.liquidate
const headOf = (bot: Bot) => bot.state().head?.number ?? 0

describe('a liquidation whose kernel simulation reverts', () => {
  it('retries a post-maturity one on the next head, with no backoff', async () => {
    const { bot, simulations } = await started(async () => false, { maturity: MATURED })
    const position = matured(1)
    bot.alive.set(keyOf(position), position)
    bot.chain.mine(false)
    await until(() => backoffOf(bot, position) !== undefined, 'the revert')
    const head = headOf(bot)
    expect(backoffOf(bot, position)).toStrictEqual({ failures: 0, until: head + 1 })
    await sleep(200)
    expect(simulations.count).toBe(1)

    simulations.answer = async () => true
    bot.chain.mine(false)
    await until(() => simulations.count === 2, 'the retry on the next head')
    expect(headOf(bot)).toBe(head + 1)
    expect(backoffOf(bot, position)?.failures).toBe(0)
  })

  it('backs off a normal-mode one', async () => {
    const { bot } = await started(async () => false)
    const position = unhealthy(0, 2)
    bot.alive.set(keyOf(position), position)
    bot.chain.mine(false)
    await until(() => backoffOf(bot, position) !== undefined, 'the backoff')
    expect(backoffOf(bot, position)).toStrictEqual({
      failures: 1,
      until: headOf(bot) + BACKOFF_BLOCKS
    })
  })

  it('backs off a post-maturity one that sells nothing', async () => {
    const { bot } = await started(async () => false, { maturity: MATURED })
    const position = { ...matured(5), slots: [1] }
    bot.alive.set(keyOf(position), position)
    bot.chain.mine(false)
    await until(() => backoffOf(bot, position) !== undefined, 'the backoff')
    expect(backoffOf(bot, position)?.failures).toBe(1)
  })

  it('backs off a post-maturity one whose simulation failed in transport', async () => {
    const { bot } = await started(() => Promise.reject(new Error('the RPC is down')), {
      maturity: MATURED
    })
    const position = matured(3)
    bot.alive.set(keyOf(position), position)
    bot.chain.mine(false)
    await until(() => backoffOf(bot, position) !== undefined, 'the backoff')
    expect(backoffOf(bot, position)?.failures).toBe(1)
  })

  it('backs off a post-maturity one that reverted onchain', async () => {
    const { bot } = await started(async () => true, { maturity: MATURED, squeeze: () => true })
    const position = matured(4)
    bot.alive.set(keyOf(position), position)
    bot.mining(true)
    await until(() => backoffOf(bot, position) !== undefined, 'the backoff')
    bot.mining(false)
    expect(backoffOf(bot, position)?.failures).toBe(1)
    expect([...bot.chain.included.values()].flat().map(tx => tx.status)).toStrictEqual(['reverted'])
  })
})
