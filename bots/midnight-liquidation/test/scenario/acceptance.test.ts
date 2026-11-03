import type { JournalEntry } from '@repo/engine'
import type { KernelState } from '@repo/kernel'

import { parseIntentId } from '@repo/controller'
import { GraphDefinitionError } from '@repo/engine'
import { replay } from '@repo/engine/replay'
import { factId } from '@repo/kernel'
import { MAX_COST_LEVEL_AGE_MS, venuePairKey } from '@repo/swaps'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Position } from './bot'

import { declareLiquidator } from '../../src/graph'
import { classifyWorld } from '../../src/report'
import { collateralAt, LOAN, positionKey, startBot, STUCK_BLOCKS, unhealthy, until } from './bot'

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

const curved = (bot: Bot, market: number) =>
  bot.runner.read(bot.nodes.curves)?.keys[
    venuePairKey({ collateral: collateralAt(market), loan: LOAN })
  ]?.status === 'present'
const bidOf = (bot: Bot, position: Position): bigint | number => {
  const candidate = bot.runner.read(bot.nodes.candidates)?.keys[keyOf(position)]
  return candidate?.status === 'present' ? candidate.value.bid : Number.NaN
}
const keyOf = (position: Position) => positionKey(position.market, position.borrower)
const add = (bot: Bot, position: Position) => bot.alive.set(keyOf(position), position)
const fact = (position: Position) => factId('positions.liquidatable', keyOf(position))
const absent = (state: KernelState, position: Position) => {
  const observation = state.observations[fact(position)]
  return observation !== undefined && 'version' in observation && observation.version === 'absent'
}
const planOf = (state: KernelState, position: Position) =>
  Object.values(state.plans).find(plan => plan.intentId.startsWith(`${keyOf(position)}#`))
const kindsAt = (state: KernelState, nonce: number) =>
  Object.values(state.nonces)
    .filter(record => record.nonce === nonce)
    .flatMap(record => record.candidates.map(candidate => candidate.kind))
const candidatesOf = (state: KernelState, position: Position) =>
  Object.values(state.nonces).flatMap(record =>
    record.candidates
      .filter(candidate => candidate.intentId.startsWith(`${keyOf(position)}#`))
      .map(candidate => ({ ...candidate, nonce: record.nonce }))
  )

describe('the Midnight liquidator on the engine', () => {
  it('liquidates independent positions at once, and a two-slot position once per slot', async () => {
    const bot = await started()
    const [a, b] = [unhealthy(0, 1), unhealthy(0, 2, [0, 1])]
    add(bot, a)
    add(bot, b)
    bot.chain.mine(false)
    await until(
      () => [a, b].every(position => candidatesOf(bot.state(), position)[0]?.sent === 'accepted'),
      'both sends'
    )
    expect([a, b].flatMap(position => candidatesOf(bot.state(), position))).toMatchObject([
      { nonce: 0 },
      { nonce: 1 }
    ])
    bot.mining(true)
    await until(() => bot.events('tx.included').length === 3, 'three settlements')
    bot.mining(false)
    const confirmed = bot.events('tx.included').map(line => line.fields.id)
    expect(confirmed.filter(id => id === keyOf(a))).toHaveLength(1)
    expect(confirmed.filter(id => id === keyOf(b))).toHaveLength(2)
    expect(bot.events('plan.built')[0]?.fields).toMatchObject({ rank: 1, collateralIndex: 0 })
    expect(bot.events('kernel.alarm')).toStrictEqual([])
  })

  it('refuses to boot with a world budget that is not a positive safe integer', async () => {
    for (const worldValidMs of [0, -1, 1.5, Number.NaN])
      await expect(startBot({ worldValidMs })).rejects.toThrow(
        new GraphDefinitionError('world needs a positive safe integer validForMs')
      )
  })

  it('stops acting on a position once failed world reads let its fact expire', async () => {
    const clock = { skew: 0 }
    const bot = await started({ now: () => Date.now() + clock.skew, worldValidMs: 1_000 })
    const a = unhealthy(0, 1)
    const sent = () => bot.events('tx.sent').filter(line => line.fields.id === keyOf(a))
    bot.world.quoteFails = true
    add(bot, a)
    bot.chain.mine(false)
    await until(() => bot.events('prepare.error').length > 0, 'the failed preparation')

    bot.world.discoverFails = true
    clock.skew = 2_000
    bot.world.quoteFails = false
    for (let reads = 1; reads <= 4; reads++) {
      bot.chain.mine(false)
      await until(() => bot.events('discover.error').length >= reads, 'a failed world read')
    }
    expect(sent()).toStrictEqual([])
    expect(bot.events('act.submitted')).toStrictEqual([])

    bot.world.discoverFails = false
    bot.chain.mine(false)
    await until(() => sent().length === 1, 'the send on a fresh read')
  })

  it('prepares a cheap route ahead of a larger gross surplus whose route costs more', async () => {
    const bot = await started({
      reservations: 1,
      concurrency: 1,
      markets: 3,
      routeCostBps: market => (market === 1 ? 9_000 : 0)
    })
    const signing = bot.chain.holdSigning()
    const decoy = unhealthy(0, 7)
    add(bot, decoy)
    bot.chain.mine(false)
    await until(
      () => planOf(bot.state(), decoy)?.phase === 'sign',
      'the decoy holding the reservation'
    )
    const [expensive, cheap] = [{ ...unhealthy(1, 8), amount: 200n }, unhealthy(2, 9)]
    add(bot, expensive)
    add(bot, cheap)
    bot.chain.mine(false)
    await until(
      () =>
        [expensive, cheap].every(
          p => bot.runner.read(bot.nodes.positions)?.keys[keyOf(p)]?.status === 'present'
        ),
      'both read'
    )
    await until(() => curved(bot, 1) && curved(bot, 2), 'both curves')
    const built = () =>
      bot
        .events('plan.built')
        .map(line => line.fields.id)
        .filter(id => id === keyOf(expensive) || id === keyOf(cheap))
    expect(built()).toStrictEqual([])
    signing.open()
    bot.chain.signing = undefined
    bot.mining(true)
    await until(() => built().length === 2, 'both prepared')
    expect(built()).toStrictEqual([keyOf(cheap), keyOf(expensive)])
  })

  it('prices a new position net in the step its world read lands, when its curve is held', async () => {
    const bot = await started({
      reservations: 0,
      markets: 3,
      routeCostBps: market => (market === 1 ? 9_000 : 0)
    })
    await until(
      () => Object.keys(bot.runner.read(bot.nodes.prices)?.keys ?? {}).length > 0,
      'the first prices'
    )
    add(bot, unhealthy(1, 11))
    add(bot, unhealthy(2, 12))
    bot.chain.mine(false)
    await until(() => curved(bot, 1) && curved(bot, 2), 'both curves')
    const [expensive, cheap] = [{ ...unhealthy(1, 13), amount: 200n }, unhealthy(2, 14)]
    add(bot, expensive)
    add(bot, cheap)
    bot.chain.mine(false)
    await until(
      () =>
        [expensive, cheap].every(
          p => bot.runner.read(bot.nodes.positions)?.keys[keyOf(p)]?.status === 'present'
        ),
      'the world read'
    )
    expect(bidOf(bot, cheap)).toBeGreaterThan(bidOf(bot, expensive))
  })

  it('resolves a route once while it is resolving, across world reads', async () => {
    const bot = await started({ reservations: 0, routeCostBps: () => 0 })
    let release = () => {}
    bot.world.routesHeld = new Promise(resolve => {
      release = resolve
    })
    add(bot, unhealthy(0, 15))
    bot.chain.mine(false)
    await until(() => bot.world.routeResolves === 1, 'the first resolve')
    const reads = bot.events('tick.end').length
    bot.chain.mine(false)
    await until(() => bot.events('tick.end').length > reads, 'a later world read')
    expect(bot.world.routeResolves).toBe(1)
    release()
    await until(() => curved(bot, 0), 'the resolved route')
    expect(bot.world.routeResolves).toBe(1)
  })

  it('falls back to gross once a held curve ages past trust, with no new head', async () => {
    const bot = await started({ reservations: 0, markets: 2, routeCostBps: () => 9_000 })
    bot.world.curvesAt = Date.now() - MAX_COST_LEVEL_AGE_MS + 1_000
    await until(
      () => Object.keys(bot.runner.read(bot.nodes.prices)?.keys ?? {}).length > 0,
      'the first prices'
    )
    const position = unhealthy(1, 15)
    add(bot, position)
    bot.chain.mine(false)
    await until(() => curved(bot, 1) && bidOf(bot, position) < 0n, 'the net bid')
    const head = bot.state().head!.number
    await until(() => bidOf(bot, position) > 0n, 'the gross bid', 5_000)
    expect(bot.state().head!.number).toBe(head)
  })

  it('keeps a declined position declined while what it would try is unchanged', async () => {
    const bot = await started({ markets: 2, routeCostBps: () => 9_000, unpriced: true })
    bot.world.quotesShort = true
    bot.world.curvesAt = Date.now() - MAX_COST_LEVEL_AGE_MS + 500
    const position = unhealthy(1, 17)
    add(bot, position)
    bot.chain.mine(false)
    await until(() => curved(bot, 1) && bot.world.quotes > 0, 'a quote on the held curve')
    const [head, quotes] = [bot.state().head!.number, bot.world.quotes]
    await sleep(1_000)
    expect(bot.state().head!.number).toBe(head)
    expect(bot.world.quotes).toBe(quotes)
  })

  it('orders no preparation by a price table once its fetches stop and it ages past its bound', async () => {
    const bot = await started({ pricesRefreshMs: 100, pricesValidMs: 1_000 })
    bot.world.quotesShort = true
    await until(
      () => Object.keys(bot.runner.read(bot.nodes.prices)?.keys ?? {}).length > 0,
      'the first prices'
    )
    const position = unhealthy(0, 18)
    const built = () => bot.events('plan.built').filter(line => line.fields.id === keyOf(position))
    add(bot, position)
    bot.chain.mine(false)
    await until(() => built().length > 0, 'a preparation on fresh prices')
    expect(built()[0]!.fields.surplusUsd).not.toBeNull()

    bot.world.pricesDown = true
    await sleep(1_200)
    const before = built().length
    bot.chain.mine(false)
    await until(() => built().length > before, 'a preparation past the bound')
    expect(
      built()
        .slice(before)
        .map(line => line.fields.surplusUsd)
    ).toStrictEqual(
      built()
        .slice(before)
        .map(() => null)
    )
    expect(bot.events('pricing.expired').at(-1)?.fields).toMatchObject({
      id: keyOf(position),
      prices: 1
    })
  })

  it('liquidates on gross while its curve sweep never settles', async () => {
    const bot = await started({ markets: 2, routeCostBps: () => 9_000 })
    bot.world.sweepsHeld = new Promise(() => {})
    const position = unhealthy(1, 16)
    add(bot, position)
    bot.chain.mine(false)
    await until(() => candidatesOf(bot.state(), position)[0]?.sent === 'accepted', 'the send')
    expect(curved(bot, 1)).toBe(false)
  })

  it('writes off a position its failed swaps backed off', async () => {
    const bot = await started({ backoffBlocks: 1_000 })
    bot.world.quoteFails = true
    const position = unhealthy(0, 10)
    add(bot, position)
    bot.chain.mine(false)
    await until(
      () => bot.events('backoff.set').some(line => line.fields.id === keyOf(position)),
      'the backoff'
    )
    position.writeOff = true
    bot.chain.mine(false)
    await until(
      () =>
        Object.values(bot.state().nonces).some(record =>
          record.candidates.some(
            c =>
              parseIntentId(c.intentId)?.key === keyOf(position) &&
              parseIntentId(c.intentId)?.task === 'writeoff'
          )
        ),
      'the write-off send'
    )
    expect(bot.runner.read(bot.nodes.backoff.state)?.keys[keyOf(position)]).toBeDefined()
    expect(bot.events('act.submitted').at(-1)?.fields.id).toBe(keyOf(position))
  })

  it('is neutral: it creates no commitment and consumes nothing, its gas reserved apart', async () => {
    const bot = await started()
    const signing = bot.chain.holdSigning()
    const position = unhealthy(0, 3)
    add(bot, position)
    bot.chain.mine(false)
    await until(() => planOf(bot.state(), position)?.phase === 'sign', 'the signature request')
    expect(planOf(bot.state(), position)!.envelope).toStrictEqual({ ids: [], consumes: {} })
    expect(planOf(bot.state(), position)!.steps[0]!.reading).toMatchObject({
      creates: [],
      exposes: [],
      consumes: {}
    })
    signing.open()
  })

  it('withdraws a held position at once when its market is delisted, before it is signed', async () => {
    const bot = await started()
    const signing = bot.chain.holdSigning()
    const position = unhealthy(0, 4)
    add(bot, position)
    bot.chain.mine(false)
    await until(() => planOf(bot.state(), position)?.phase === 'sign', 'the signature request')
    bot.world.listed.delete(0)
    await until(() => absent(bot.state(), position), 'the delisted fact')
    signing.open()
    await until(() => planOf(bot.state(), position) === undefined, 'the refused signature')
    bot.chain.signing = undefined
    expect(bot.chain.signed).toStrictEqual([])
    bot.chain.mine(false)
    await until(() => bot.events('discover.filtered').length > 0, 'a later world read')
    expect(bot.events('discover.filtered').at(-1)?.fields).toMatchObject({ listed: 0 })
    expect(bot.events('plan.built')).toHaveLength(1)
  })

  it('ends a held position at the deadline its whitelist ages out at, with no new head', async () => {
    const bot = await started({ maxAgeMs: 500 })
    const signing = bot.chain.holdSigning()
    const position = unhealthy(0, 6)
    add(bot, position)
    bot.chain.mine(false)
    await until(() => planOf(bot.state(), position)?.phase === 'sign', 'the signature request')
    const head = bot.state().head!.number
    bot.world.marketsDown = true
    await until(() => planOf(bot.state(), position) === undefined, 'the aged-out plan', 5_000)
    expect(bot.state().head!.number).toBe(head)
    signing.open()
    await sleep(50)
    expect(bot.chain.signed).toStrictEqual([])
  })

  it('refreshes the whitelist again once a refresh that threw has ended', async () => {
    const bot = await started()
    bot.world.marketsThrow = true
    await until(() => bot.events('markets.refresh_error').length > 0, 'the failed refresh')
    bot.world.listed.delete(0)
    bot.world.marketsThrow = false
    await until(
      () => bot.runner.read(bot.nodes.markets)?.sources[0]?.ids.length === 0,
      'the refreshed whitelist'
    )
  })

  it('stops acting once every markets source is older than its maximum age', async () => {
    const bot = await started({ maxAgeMs: 300 })
    bot.world.marketsDown = true
    const position = unhealthy(0, 5)
    add(bot, position)
    await until(
      () => bot.runner.read(bot.nodes.liquidatable)?.keys[keyOf(position)] === undefined,
      'nothing before a read'
    )
    await new Promise(resolve => setTimeout(resolve, 400))
    bot.chain.mine(false)
    await until(() => bot.events('markets.whitelist_expired').length > 0, 'the expired whitelist')
    const reads = bot.events('tick.end').length
    bot.chain.mine(false)
    await until(() => bot.events('tick.end').length > reads, 'a later world read')
    expect(bot.events('plan.built')).toStrictEqual([])
    expect(bot.chain.signed).toStrictEqual([])

    bot.world.marketsDown = false
    bot.mining(true)
    await until(() => bot.events('tx.included').length === 1, 'the settlement')
  }, 20_000)

  it('counts no liquidatable position while the whitelist is expired', async () => {
    const bot = await started({ maxAgeMs: 300, reservations: 0 })
    const position = unhealthy(0, 6)
    add(bot, position)
    bot.chain.mine(false)
    const held = () => bot.runner.read(bot.nodes.liquidatable)?.keys[keyOf(position)]?.status
    await until(() => held() === 'present', 'the listed position')
    bot.world.marketsDown = true
    await until(() => held() !== 'present', 'the expired whitelist')
    const sizing = bot.runner.read(bot.nodes.sizing)
    expect(sizing?.keys[keyOf(position)]?.status).toBe('present')
    expect(
      classifyWorld({ sizing, liquidatable: bot.runner.read(bot.nodes.liquidatable) })
    ).toMatchObject({ liquidatable: 0, planned: 0 })
  })

  it('re-bids a send stuck past 4s rather than filling its nonce', async () => {
    const clock = { skew: 0 }
    const bot = await started({ now: () => Date.now() + clock.skew })
    const position = unhealthy(0, 11)
    add(bot, position)
    bot.chain.mine(false)
    await until(() => candidatesOf(bot.state(), position)[0]?.sent === 'accepted', 'the send')
    clock.skew = 5_000
    for (let block = 0; block <= STUCK_BLOCKS; block++) bot.chain.mine(false)
    await until(() => candidatesOf(bot.state(), position).length === 2, 'the re-bid')
    expect(kindsAt(bot.state(), 0)).toStrictEqual(['step', 'step'])
    expect(planOf(bot.state(), position)).toMatchObject({ status: 'executing', phase: 'include' })
    bot.mining(true)
    await until(() => !bot.alive.has(keyOf(position)), 'the liquidation')
    expect(bot.events('tx.cancelled')).toStrictEqual([])
  })

  it('ages a send out at its send life while world reads keep refreshing its fact', async () => {
    const clock = { skew: 0 }
    const bot = await started({
      now: () => Date.now() + clock.skew,
      worldValidMs: 20_000,
      sendLifeMs: 40_000
    })
    const position = unhealthy(0, 12)
    add(bot, position)
    bot.chain.mine(false)
    await until(() => candidatesOf(bot.state(), position)[0]?.sent === 'accepted', 'the send')
    for (clock.skew = 5_000; clock.skew < 40_000; clock.skew += 5_000) {
      const reads = bot.events('tick.end').length
      bot.chain.mine(false)
      await until(() => bot.events('tick.end').length > reads, 'a world read')
      expect(planOf(bot.state(), position)?.status).toBe('executing')
    }
    clock.skew = 41_000
    await until(() => planOf(bot.state(), position)?.status !== 'executing', 'the cancellation')
    expect(bot.events('tick.end').at(-1)?.fields).toMatchObject({ liquidatable: 1 })
    for (let block = 0; block <= STUCK_BLOCKS; block++) bot.chain.mine(false)
    await until(() => kindsAt(bot.state(), 0).includes('fill'), 'the nonce fill')
    bot.mining(true)
    await until(() => bot.events('tx.included').length > 0, 'the liquidation on a fresh quote')
    expect(bot.events('act.submitted').map(line => line.fields.id)).toStrictEqual([
      keyOf(position),
      keyOf(position)
    ])
    expect(bot.events('tx.included').at(-1)?.fields).toMatchObject({
      id: keyOf(position),
      nonce: 1
    })
  })

  it('cancels a sent liquidation of a delisted market at its last listed read’s expiry', async () => {
    const clock = { skew: 0 }
    const bot = await started({ now: () => Date.now() + clock.skew, worldValidMs: 10_000 })
    const position = unhealthy(0, 13)
    add(bot, position)
    bot.chain.mine(false)
    await until(() => candidatesOf(bot.state(), position)[0]?.sent === 'accepted', 'the send')
    clock.skew = 5_000
    bot.world.listed.delete(0)
    await until(() => absent(bot.state(), position), 'the delisted fact')
    await sleep(50)
    expect(planOf(bot.state(), position)?.status).toBe('executing')
    clock.skew = 10_000
    await until(() => planOf(bot.state(), position)?.status !== 'executing', 'the cancellation')
    expect(candidatesOf(bot.state(), position)).toHaveLength(1)
  })

  it('cancels a sent liquidation of a delisted market earlier, at its stuck re-bid', async () => {
    const clock = { skew: 0 }
    const bot = await started({ now: () => Date.now() + clock.skew, worldValidMs: 60_000 })
    const position = unhealthy(0, 14)
    add(bot, position)
    bot.chain.mine(false)
    await until(() => candidatesOf(bot.state(), position)[0]?.sent === 'accepted', 'the send')
    clock.skew = 5_000
    bot.world.listed.delete(0)
    await until(() => absent(bot.state(), position), 'the delisted fact')
    await sleep(50)
    expect(planOf(bot.state(), position)?.status).toBe('executing')
    for (let block = 0; block <= STUCK_BLOCKS; block++) bot.chain.mine(false)
    await until(() => planOf(bot.state(), position)?.status !== 'executing', 'the cancellation')
    expect(kindsAt(bot.state(), 0).filter(kind => kind === 'step')).toHaveLength(1)
  })

  it('replays its journal on a graph rebuilt later with an empty whitelist cache', async () => {
    const entries: JournalEntry[] = []
    const journal = {
      sink: {
        append: async (entry: JournalEntry) => void entries.push(entry),
        finalize: async () => {}
      },
      capacityBytes: 10_000_000
    }
    const bot = await started({ journal })
    const position = unhealthy(0, 7)
    add(bot, position)
    bot.mining(true)
    await until(() => bot.events('tx.included').length === 1, 'the settlement')
    await bot.shutdown()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_400_000)
    const refresh = vi.fn(async () => [])
    const { graph } = declareLiquidator({
      ...bot.options,
      markets: { ...bot.options.markets, refresh }
    })
    vi.restoreAllMocks()
    expect(refresh).not.toHaveBeenCalled()
    expect(replay(graph, entries)).toStrictEqual({ ok: true, steps: expect.any(Number) })
  })
})
