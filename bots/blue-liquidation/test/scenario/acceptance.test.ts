import type { KernelState } from '@repo/kernel'
import type { Address } from 'viem'

import { GraphFailedError, keyRecord } from '@repo/engine'
import { factId } from '@repo/kernel'
import { FakeChain, MemoryStore } from '@repo/kernel/testing'
import { createLogger } from '@repo/kit'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config'
import { liquidatorAccount, liquidatorKernel } from '../../src/kernel'
import { borrowerAt, positionKey, startBot, until } from './bot'

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

const fact = (borrower: Address) => factId('positions.liquidatable', positionKey(borrower))
const absent = (state: KernelState, borrower: Address) => {
  const observation = state.observations[fact(borrower)]
  return observation !== undefined && 'version' in observation && observation.version === 'absent'
}
const planOf = (state: KernelState, borrower: Address) =>
  Object.values(state.plans).find(plan => plan.intentId.startsWith(`${positionKey(borrower)}#`))
const candidatesOf = (state: KernelState, borrower: Address) =>
  Object.values(state.nonces).flatMap(record =>
    record.candidates
      .filter(candidate => candidate.intentId.startsWith(`${positionKey(borrower)}#`))
      .map(candidate => ({
        ...candidate,
        nonce: record.nonce,
        resolved: record.resolution !== undefined
      }))
  )
const sentFor = (bot: Bot, borrower: Address) =>
  bot.events('tx.sent').filter(line => line.fields.id === positionKey(borrower))

/** The block windows the live kernel uses on Robinhood's 100ms blocks. */
const robinhoodWindows = () => {
  const config = loadConfig({
    CHAIN_ID: '4663',
    FINALITY_4663: 'safe',
    RPC_URL: 'http://localhost:8545',
    LIQUIDATOR_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
    MORPHO_API_KEY: 'morpho-key',
    KERNEL_STATE_DIR: '/nonexistent',
    KERNEL_ENROLLMENT: 'enrolling',
    MAX_FEE_GWEI: '250',
    ZEROX_API_KEY: 'zx-key'
  })
  const { live } = liquidatorKernel({
    config,
    account: liquidatorAccount(config),
    logger: createLogger('error', { env: {} })
  })
  const { maxSimLagBlocks, maxEvidenceAgeBlocks } = live.config
  return { maxSimLagBlocks, maxEvidenceAgeBlocks, reorgDepth: live.reorgDepth }
}

describe('the blue liquidator on the engine', () => {
  it("starts on Robinhood's windows without a world read per block of its first window", async () => {
    const chain = new FakeChain()
    chain.height = 3_000
    chain.finalityLag = 2_500
    const bot = await started({ chain, windows: robinhoodWindows() })
    bot.world.readDelayMs = 20
    await until(() => bot.events('tick.end').length > 0, 'a world read')
    expect(bot.state().lifecycle.kind).toBe('running')
    expect(bot.events('tick.end').length).toBeLessThan(10)
  })

  it('follows a poll gap of a thousand blocks without a world read per block', async () => {
    const chain = new FakeChain()
    const bot = await started({ chain })
    bot.world.readDelayMs = 20
    const settled = bot.stopped.then(
      () => 'stopped',
      () => 'failed'
    )
    chain.height += 1_000
    await until(() => bot.state().head?.number === chain.height, 'the head past the gap')
    await until(() => bot.events('tick.end').length > 0, 'a world read')
    expect(
      await Promise.race([settled, new Promise(resolve => setTimeout(resolve, 100, 'live'))])
    ).toBe('live')
    expect(bot.state().lifecycle.kind).toBe('running')
    expect(bot.events('tick.end').length).toBeLessThan(10)
  })

  it('acts on new and independent positions at once, and holds each guard at its boundary', async () => {
    const bot = await started()

    // A newly discovered position acts with no key list; two independent ones are both pending
    // before either receipt.
    const [a, b] = [borrowerAt(1), borrowerAt(2)]
    bot.alive.add(a)
    bot.alive.add(b)
    bot.chain.mine(false)
    await until(
      () => [a, b].every(borrower => candidatesOf(bot.state(), borrower)[0]?.sent === 'accepted'),
      'both sends'
    )
    expect([a, b].flatMap(borrower => candidatesOf(bot.state(), borrower))).toMatchObject([
      { nonce: 0, resolved: false },
      { nonce: 1, resolved: false }
    ])
    bot.chain.mine()
    await until(() => bot.events('tx.included').length === 2, 'both confirmations')

    // A held ledger write blocks the dependent handoff while observations and kernel transitions
    // go on; the fact the act rests on changes during persistence, and the neutral act still goes.
    const held = bot.store.hold()
    const c = borrowerAt(3)
    bot.alive.add(c)
    bot.chain.mine(false)
    await until(() => planOf(bot.state(), c)?.phase === 'commit', 'the commit')
    const headAtCommit = bot.state().head!.number
    bot.alive.delete(c)
    bot.chain.mine(false)
    await until(
      () => bot.state().head!.number > headAtCommit && absent(bot.state(), c),
      'the observation while the write is held'
    )
    expect(sentFor(bot, c)).toStrictEqual([])
    held.open()
    await until(() => sentFor(bot, c).length === 1, 'the handoff after the write')
    bot.mining(true)
    await until(() => planOf(bot.state(), c) === undefined, 'the reverted act to end')
    bot.mining(false)
    expect(bot.events('tx.reverted').map(line => line.fields.id)).toStrictEqual([positionKey(c)])

    // A fact that changes after the kernel asked for a signature, but before the signer signs,
    // stops the signer: nothing is signed and no nonce is spent.
    const signing = bot.chain.holdSigning()
    const signedBefore = bot.chain.signed.length
    const d = borrowerAt(4)
    bot.alive.add(d)
    bot.chain.mine(false)
    await until(() => planOf(bot.state(), d)?.phase === 'sign', 'the signature request')
    bot.alive.delete(d)
    bot.chain.mine(false)
    await until(() => absent(bot.state(), d), 'the changed fact')
    signing.open()
    await until(() => planOf(bot.state(), d) === undefined, 'the refused signature')
    bot.chain.signing = undefined
    expect(bot.chain.signed.length).toBe(signedBefore)
    expect(candidatesOf(bot.state(), d)).toStrictEqual([])

    // A failed discovery leaves coverage unknown: no position becomes absent, and the act in
    // flight keeps its observation and settles.
    const e = borrowerAt(5)
    bot.alive.add(e)
    bot.chain.mine(false)
    await until(() => candidatesOf(bot.state(), e)[0]?.sent === 'accepted', 'the send')
    const observed = bot.state().observations[fact(e)]
    bot.world.discoverFails = true
    bot.chain.mine(false)
    await until(
      () => bot.runner.read(bot.nodes.positions)?.coverage.status === 'failed',
      'the failed read'
    )
    expect(keyRecord(bot.runner.read(bot.nodes.positions)!, positionKey(e)).status).toBe('present')
    expect(bot.state().observations[fact(e)]).toStrictEqual(observed)
    bot.world.discoverFails = false
    bot.mining(true)
    await until(
      () => bot.events('tx.included').some(line => line.fields.id === positionKey(e)),
      'the settlement'
    )

    expect(bot.events('tx.sent').filter(line => line.fields.kind === 'fill')).toStrictEqual([])
    expect(bot.events('kernel.alarm')).toStrictEqual([])
    expect(bot.events('tick.end').length).toBeGreaterThan(0)
  }, 30_000)

  it('backs a position off and runs on when its preparation throws', async () => {
    const bot = await started()
    const [a, b] = [borrowerAt(10), borrowerAt(11)]
    bot.world.simulateThrows = true
    bot.world.logFailsOn = 'prepare.error'
    bot.alive.add(a)
    bot.chain.mine(false)
    await until(() => bot.events('act.prepare_failed').length > 0, 'the thrown preparation')
    expect(bot.events('act.prepare_failed')[0]?.fields).toMatchObject({
      id: positionKey(a),
      reason: 'prepare_threw',
      error: 'Error'
    })
    expect(bot.events('backoff.set')[0]?.fields).toMatchObject({
      id: positionKey(a),
      reason: 'prepare_threw'
    })

    bot.world.simulateThrows = false
    bot.world.logFailsOn = undefined
    bot.alive.add(b)
    bot.mining(true)
    await until(() => !bot.alive.has(a) && !bot.alive.has(b), 'both liquidations')
    expect(bot.state().lifecycle.kind).toBe('running')
  })

  it('halts and stops its kernel cleanly when its graph fails, landing the send in flight', async () => {
    const bot = await started()
    const [a, b] = [borrowerAt(7), borrowerAt(8)]
    bot.alive.add(a)
    bot.chain.mine(false)
    await until(() => candidatesOf(bot.state(), a)[0]?.sent === 'accepted', 'the first send')

    bot.world.logFailsOn = 'tick.end'
    bot.alive.add(b)
    bot.chain.mine(false)
    await until(() => bot.state().lifecycle.kind !== 'running', 'the halt')
    bot.mining(true)
    const error = await bot.stopped.catch((value: unknown) => value)

    expect(error).toBeInstanceOf(GraphFailedError)
    expect(error).toMatchObject({
      origin: 'liquidations.log',
      stop: {
        type: 'report',
        outcome: 'clean',
        reason: 'liquidations.log failed: Error',
        open: { entries: [], nonces: [] }
      }
    })
    expect(bot.alive.has(a)).toBe(false)
    expect(candidatesOf(bot.state(), b)).toStrictEqual([])
  })

  it('keeps an uncertain send across a crash and reconciles it, sending the position once', async () => {
    const chain = new FakeChain()
    const store = new MemoryStore()
    const alive = new Set<Address>()
    const first = await started({ chain, store, alive })
    const f = borrowerAt(6)
    alive.add(f)
    chain.mine(false)
    await until(() => candidatesOf(first.state(), f)[0]?.sent === 'accepted', 'the send')
    await first.runner.abandon()

    const second = await startBot({ chain, store, alive, enrollment: 'enrolled', runId: 'again' })
    bots.push(second)
    await until(() => second.state().lifecycle.kind !== 'idle', 'the restart')
    expect(candidatesOf(second.state(), f)).toMatchObject([{ sent: 'unknown', resolved: false }])
    chain.mine(false)
    await until(() => second.events('tick.end').length > 0, 'a world read after the restart')
    expect(chain.signed).toHaveLength(1)
    second.mining(true)
    await until(() => Object.keys(second.state().nonces).length === 0, 'the reconciled send')
    expect(second.state().lifecycle.kind).toBe('running')
    expect(alive.has(f)).toBe(false)
    expect(chain.signed).toHaveLength(1)
  })

  it('stops acting on a position once failed world reads let its fact expire', async () => {
    const clock = { skew: 0 }
    const bot = await started({ now: () => Date.now() + clock.skew, worldValidMs: 1_000 })
    const a = borrowerAt(1)
    bot.world.quoteFails = true
    bot.alive.add(a)
    bot.chain.mine(false)
    await until(() => bot.events('quote.error').length > 0, 'the failed quote')

    bot.world.discoverFails = true
    clock.skew = 2_000
    bot.world.quoteFails = false
    for (let reads = 1; reads <= 4; reads++) {
      bot.chain.mine(false)
      await until(() => bot.events('discover.error').length >= reads, 'a failed world read')
    }
    expect(sentFor(bot, a)).toStrictEqual([])
    expect(bot.events('act.submitted')).toStrictEqual([])

    bot.world.discoverFails = false
    bot.chain.mine(false)
    await until(() => sentFor(bot, a).length === 1, 'the send on a fresh read')
  })

  it('rests on its position and its quote, and never quotes again while its send is out', async () => {
    const clock = { skew: 0 }
    const borrower = borrowerAt(1)
    const bot = await started({
      now: () => Date.now() + clock.skew,
      survives: new Map([[borrower, 1]])
    })
    bot.alive.add(borrower)
    bot.chain.mine(false)
    await until(() => candidatesOf(bot.state(), borrower)[0]?.sent === 'accepted', 'the send')
    const key = positionKey(borrower)
    expect(planOf(bot.state(), borrower)?.evidence).toMatchObject([
      { id: factId('positions.liquidatable', key), basis: { block: expect.any(Number) } },
      { id: factId('quotes.route', key), basis: { observedAt: expect.any(Number) } }
    ])
    expect(bot.world.quotes).toBe(1)

    clock.skew = 61_000
    for (let reads = 1; reads <= 3; reads++) {
      const head = bot.state().head!.number
      bot.chain.mine(false)
      await until(() => bot.state().head!.number > head, 'a head with the send out')
    }
    await until(() => bot.events('tick.end').length > 3, 'the world reads')
    expect(bot.world.quotes).toBe(1)

    bot.mining(true)
    await until(() => bot.world.quotes === 2, 'the quote once the send resolved')
  })

  it('quotes a position again when its seize shrank while its quote was out', async () => {
    const bot = await started()
    const borrower = borrowerAt(12)
    const held = Promise.withResolvers<void>()
    bot.world.quoteHeld = held.promise
    bot.alive.add(borrower)
    bot.chain.mine(false)
    await until(() => bot.world.quotes === 1, 'the first quote')

    bot.world.collateralCut = 10n ** 17n
    const ticks = bot.events('tick.end').length
    bot.chain.mine(false)
    await until(() => bot.events('tick.end').length > ticks, 'the read with the smaller seize')
    bot.world.quoteHeld = undefined
    held.resolve()

    await until(() => bot.world.quotes === 2, 'the quote of the smaller seize')
    bot.mining(true)
    await until(() => !bot.alive.has(borrower), 'the liquidation')
    expect(bot.state().lifecycle.kind).toBe('running')
  })

  it('quotes a position its preparation backed off only once the backoff passes', async () => {
    const clock = { skew: 0 }
    const bot = await started({
      now: () => Date.now() + clock.skew,
      backoff: { baseBlocks: 8, maxBlocks: 8 }
    })
    const borrower = borrowerAt(13)
    bot.world.simulateThrows = true
    bot.alive.add(borrower)
    bot.chain.mine(false)
    await until(() => bot.events('backoff.set').length > 0, 'the backoff')
    const { untilBlock } = bot.events('backoff.set')[0]!.fields as { untilBlock: number }
    bot.world.simulateThrows = false

    clock.skew = 61_000
    const mineTo = async (block: number) => {
      while (bot.state().head!.number < block) {
        const ticks = bot.events('tick.end').length
        bot.chain.mine(false)
        await until(() => bot.events('tick.end').length > ticks, 'a world read')
      }
    }
    await mineTo(untilBlock - 1)
    expect(bot.world.quotes).toBe(1)

    await mineTo(untilBlock)
    await until(() => bot.world.quotes === 2, 'the quote once the backoff passed')
  })

  it('holds a quote waiting on the venue budget while its preparation backs the key off', async () => {
    const bot = await started({
      backoff: { baseBlocks: 8, maxBlocks: 8 },
      venueBudget: { calls: 1, perMs: 1_500 }
    })
    const borrower = borrowerAt(16)
    const simulated = Promise.withResolvers<void>()
    bot.world.simulateHeld = simulated.promise
    bot.world.simulateThrows = true
    bot.alive.add(borrower)
    bot.chain.mine(false)
    await until(() => bot.events('plan.built').length > 0, 'the first preparation')

    bot.world.collateralCut = 10n ** 17n
    const ticks = bot.events('tick.end').length
    bot.chain.mine(false)
    await until(() => bot.events('tick.end').length > ticks, 'the read with the smaller seize')
    simulated.resolve()
    await until(() => bot.events('backoff.set').length > 0, 'the backoff')
    const { untilBlock } = bot.events('backoff.set')[0]!.fields as { untilBlock: number }
    bot.world.simulateThrows = false
    await sleep(1_700)
    expect(bot.world.quotes).toBe(1)

    while (bot.state().head!.number < untilBlock) {
      const head = bot.state().head!.number
      bot.chain.mine(false)
      await until(() => bot.state().head!.number > head, 'a head')
    }
    await until(() => bot.world.quotes === 2, 'the quote once the backoff passed')
  })

  it('keeps a failed quote waiting while its position is briefly healthy', async () => {
    const bot = await started({ backoff: { baseBlocks: 8, maxBlocks: 8 } })
    const [a, b] = [borrowerAt(14), borrowerAt(15)]
    const mineOne = async () => {
      const ticks = bot.events('tick.end').length
      bot.chain.mine(false)
      await until(() => bot.events('tick.end').length > ticks, 'a world read')
    }
    bot.world.quoteFails = true
    bot.alive.add(a)
    await mineOne()
    await until(() => bot.events('backoff.set').length > 0, 'the failed quote')
    const { untilBlock } = bot.events('backoff.set')[0]!.fields as { untilBlock: number }
    bot.world.quoteFails = false

    bot.alive.delete(a)
    bot.alive.add(b)
    await mineOne()
    await until(() => bot.world.quotes === 2, 'the quote of the other position')
    bot.alive.add(a)
    while (bot.state().head!.number < untilBlock - 1) await mineOne()
    expect(bot.world.quotes).toBe(2)

    await mineOne()
    await until(() => bot.world.quotes === 3, 'the quote once the wait passed')
  })

  it('is neutral: it creates no commitment and consumes nothing, its gas reserved apart', async () => {
    const bot = await started()
    const signing = bot.chain.holdSigning()
    const borrower = borrowerAt(1)
    bot.alive.add(borrower)
    bot.chain.mine(false)
    await until(() => planOf(bot.state(), borrower)?.phase === 'sign', 'the signature request')
    const plan = planOf(bot.state(), borrower)!
    expect(plan.envelope).toStrictEqual({ ids: [], consumes: {} })
    expect(plan.steps[0]!.reading).toMatchObject({ creates: [], exposes: [], consumes: {} })
    signing.open()
  })

  it('liquidates one position again and again against a slow world read, never refused', async () => {
    const borrower = borrowerAt(9)
    const liquidations = 4
    const bot = await started({ survives: new Map([[borrower, liquidations - 1]]) })
    bot.world.readDelayMs = 60
    bot.alive.add(borrower)
    bot.mining(true)
    await until(() => !bot.alive.has(borrower), 'every liquidation of the position')
    await until(() => planOf(bot.state(), borrower) === undefined, 'the last settlement')
    expect(bot.events('liquidation.not_sent')).toStrictEqual([])
    expect(bot.events('backoff.set')).toStrictEqual([])
    expect(sentFor(bot, borrower)).toHaveLength(liquidations)
  })

  it.each([
    [4, 1, 1_000],
    [4, 1, 3]
  ])(
    'liquidates a burst against a lens that moves every block: %i reservations, finality %i behind, route for %i a block',
    async (reservations, finalityLag, routePerBlock) => {
      const positions = 48
      const chain = new FakeChain()
      chain.finalityLag = finalityLag
      const alive = new Set(Array.from({ length: positions }, (_, i) => borrowerAt(100 + i)))
      const bot = await started({
        chain,
        alive,
        reservations,
        squeeze: index => index >= routePerBlock
      })
      const firstBlock = chain.height + 1
      bot.mining(true)
      await until(() => alive.size === 0, 'every position liquidated', 60_000)
      const settled = [...chain.included]
        .filter(([height]) => height >= firstBlock)
        .flatMap(([, txs]) => txs)
        .filter(tx => tx.status === 'success').length
      expect(settled).toBe(positions)
      expect(bot.events('tx.sent').filter(line => line.fields.kind === 'fill')).toStrictEqual([])
      expect(bot.events('kernel.alarm')).toStrictEqual([])
    },
    90_000
  )
})
