import type { JournalEntry, Keyed, KeyedWrite, RunnerOptions, State } from '@repo/engine'

import {
  createGraph,
  createRunner,
  GraphDefinitionError,
  GraphFailedError,
  JournalOverflowError,
  keyedLevel,
  keyedMap,
  latest,
  sourceWrite
} from '@repo/engine'
import { replay } from '@repo/engine/replay'
import { layoutOf } from '@repo/engine/testing'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'

import type {
  Block,
  KernelChain,
  KernelEffects,
  KernelActivity,
  KernelHostOptions,
  KernelState,
  EffectGuard
} from '../src'
import type { RawRequest } from './fixtures'

import { declareKernel, declareKernelHost, factId, KernelJournalRequiredError } from '../src'
import { MemoryStore, startKernel } from '../src/testing'
import { encodeCall, fnOf } from './codec'
import {
  ecrecoverPlan,
  FRESH_UNTIL,
  liquidationPlan,
  makeConfig,
  offer,
  onNotices,
  publish,
  setterPlan,
  T,
  tree,
  unauthored,
  until,
  W
} from './fixtures'
import { midnightId } from './validators'

/** One chain per test: `branch` names the canonical fork, and blocks above `forkAt` carry it. */
class FakeChain implements KernelChain {
  height = 1
  finalized = 0
  branch = 'A'
  forkAt = 0
  receipts = new Map<string, { block: number; branch: string }>()
  onReceipt?: () => void

  hashOf(number: number, branch = this.branch) {
    return number <= this.forkAt ? `0x${number}A` : `0x${number}${branch}`
  }
  blockAt(number: number, branch = this.branch): Block {
    return {
      number,
      hash: this.hashOf(number, branch),
      parentHash: this.hashOf(number - 1, branch),
      timestamp: BigInt(number * 2)
    }
  }
  latest = async () => {
    if (this.latestDelayMs > 0) await sleep(this.latestDelayMs)
    return {
      head: this.blockAt(this.height),
      finalized: { number: this.finalized, timestamp: BigInt(this.finalized * 2) }
    }
  }
  beforeBlock?: (number: number) => Promise<void>
  latestDelayMs = 0
  block = async (number: number) => {
    await this.beforeBlock?.(number)
    if (number > this.height) throw new Error(`no block ${number}`)
    return this.blockAt(number)
  }
  nonce = 0
  nonceAt = () => Promise.resolve({ latest: this.nonce, pending: this.nonce })
  code = '0x'
  accountCode = () => Promise.resolve(this.code)
  minedAt?: { hash: string; block: number; branch: string }
  receipt = (hash: string) => {
    this.onReceipt?.()
    const found = this.receipts.get(hash)
    if (!found || (found.block > this.forkAt && found.branch !== this.branch))
      return Promise.resolve(null)
    return Promise.resolve({
      block: found.block,
      blockHash: this.hashOf(found.block, found.branch),
      status: 'success' as const,
      logs: []
    })
  }
  lookups = 0
  nonceTx: KernelChain['nonceTx'] = () => {
    this.lookups++
    const mined = this.minedAt
    if (!mined) return Promise.resolve(null)
    return Promise.resolve({
      hash: mined.hash,
      block: mined.block,
      blockHash: this.hashOf(mined.block, mined.branch),
      status: 'success' as const,
      logs: []
    })
  }
  commitment = () => Promise.reject(new Error('none'))
  capacityReads: string[] = []
  capacity = (_resource: string, at: Block) => {
    this.capacityReads.push(at.hash)
    return Promise.resolve(1_000n)
  }
}

const effects = (overrides: Partial<KernelEffects> = {}): KernelEffects => ({
  materialize: () => Promise.reject(new Error('none')),
  simulate: () => Promise.resolve(true),
  signTx: payload => {
    const name = fnOf(payload) ?? 'fill'
    return Promise.resolve({ hash: `0x${name}`, raw: `raw:${name}` })
  },
  signTyped: () => Promise.reject(new Error('none')),
  broadcast: () => Promise.resolve('accepted'),
  release: () => Promise.reject(new Error('none')),
  ...overrides
})

/** The kernel on its own runner, seen through the surface its traces drive. */
const alarmsIn = (activity: readonly KernelActivity[]) =>
  activity.flatMap(a => (a.type === 'alarm' ? [a.reason] : []))

const journal = (append: (entry: JournalEntry) => Promise<void>, capacityBytes = 1_000_000) => ({
  sink: { append, finalize: async () => undefined },
  capacityBytes
})

const start = async (
  overrides: Partial<KernelHostOptions> & Pick<RunnerOptions, 'journal'> = {}
) => {
  const alarms: string[] = []
  const { runner, nodes, stopped } = await startKernel({
    config: makeConfig({ maxDispatchLagMs: 5_000 }),
    store: new MemoryStore(),
    chain: new FakeChain(),
    effects: effects(),
    enrollment: 'enrolling',
    pollMs: 5,
    effectTimeoutMs: 1_000,
    reorgDepth: 16,
    onError: () => {},
    now: () => 0,
    ...overrides,
    onActivity: activity => {
      alarms.push(...alarmsIn(activity))
      overrides.onActivity?.(activity)
    }
  })
  return {
    send: (event: RawRequest) => runner.push(unauthored(nodes.requests), event),
    state: () => structuredClone(runner.read(nodes.state)!),
    hasJournal: runner.hasJournal,
    alarms: () => [...alarms],
    stopped,
    abandon: runner.abandon
  }
}

const running = (driver: Awaited<ReturnType<typeof start>>) =>
  until(() => driver.state().lifecycle.kind === 'running', 'running')

describe('the kernel hosted on the engine', () => {
  it('gives test-only startKernel an in-memory journal by default', async () => {
    const driver = await start()
    expect(driver.hasJournal).toBe(true)
    await driver.abandon()
  })

  it('hands the signer the nonce, the spend ceiling, and the fee level of the candidate', async () => {
    const signed: Parameters<KernelEffects['signTx']>[1][] = []
    const driver = await start({
      effects: effects({
        signTx: (payload, candidate) => {
          signed.push(candidate)
          return Promise.resolve({ hash: `0x${fnOf(payload)}`, raw: 'raw' })
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => signed.length > 0, 'the signature')
    expect(signed[0]).toEqual({ nonce: 0, fee: makeConfig().feeReserve, level: 1 })
    await driver.abandon()
  })

  it('hands over the activity of each transition in order, despite a throwing listener', async () => {
    const seen: string[] = []
    const chain = new FakeChain()
    const driver = await start({
      chain,
      onActivity: activity => {
        seen.push(...activity.map(a => (a.type === 'notice' ? `notice ${a.notice}` : a.type)))
        throw new Error('listener failed')
      }
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => seen.includes('sent'), 'the broadcast')
    chain.receipts.set('0xexec', { block: 2, branch: 'A' })
    chain.height = 4
    await until(() => seen.includes('notice settled'), 'the settlement')
    expect(seen).toEqual(['notice admitted', 'sent', 'included', 'notice settled'])
    await driver.abandon()
  })

  it('rolls back to finality on a reorg deeper than it retains, so orphaned evidence is not final', async () => {
    const chain = new FakeChain()
    const driver = await start({ chain, reorgDepth: 2 })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0] !== undefined, 'the broadcast')
    chain.receipts.set('0xexec', { block: 2, branch: 'A' })
    chain.height = 4
    await until(() => driver.state().nonces[0]?.resolution !== undefined, 'the receipt')
    chain.forkAt = 1
    chain.branch = 'B'
    chain.height = 8
    chain.finalized = 6
    await until(() => driver.state().head?.hash === '0x8B', 'the new branch')
    expect(driver.alarms()).toContain('reorg deeper than the adapter retains')
    expect(driver.state().nonces[0]).toBeDefined()
    expect(driver.state().nonces[0]?.resolution).toBeUndefined()
    await driver.abandon()
  })

  it('halts rather than follow a head that forks below the finalized anchor', async () => {
    const chain = new FakeChain()
    chain.height = 10
    chain.finalized = 8
    const driver = await start({ chain })
    await running(driver)
    await until(() => driver.state().finalized.number === 8, 'the anchor')
    const latest = chain.latest
    const block = chain.block
    const held = Promise.withResolvers<void>()
    let polledAgain = false
    chain.forkAt = 7
    chain.height = 12
    chain.latest = () => {
      chain.latest = async () => {
        polledAgain = true
        await held.promise
        return latest()
      }
      return Promise.resolve({
        head: chain.blockAt(12, 'B'),
        finalized: { number: 8, timestamp: 16n }
      })
    }
    chain.block = async number => {
      if (number !== 8 || chain.branch === 'B') return block(number)
      chain.branch = 'B'
      return chain.blockAt(8, 'A')
    }
    await Promise.race([driver.stopped, until(() => polledAgain, 'the next poll')])
    expect(driver.state().head?.hash).not.toBe('0x12B')
    expect(driver.alarms().some(a => a.startsWith('finality violated'))).toBe(true)
    held.resolve()
    await driver.abandon()
  })

  it('forgets a final-looking receipt when the finalized chain is replaced, so it cannot settle', async () => {
    const chain = new FakeChain()
    const held = Promise.withResolvers<void>()
    const driver = await start({
      chain,
      reorgDepth: 2,
      effects: effects({
        broadcast: async () => {
          await held.promise
          return 'accepted'
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0] !== undefined, 'the commit')
    chain.receipts.set('0xexec', { block: 8, branch: 'A' })
    chain.height = 10
    chain.finalized = 10
    await until(() => driver.state().nonces[0]?.resolution !== undefined, 'the receipt')
    chain.forkAt = 1
    chain.branch = 'B'
    chain.height = 11
    await until(() => driver.state().head?.hash === '0x11B', 'the new branch')
    held.resolve()
    await sleep(50)
    expect(driver.state().nonces[0]).toBeDefined()
    expect(driver.state().nonces[0]?.resolution).toBeUndefined()
    await driver.abandon()
  })

  it('reads nothing at a tip fetched before the finalized chain was found replaced', async () => {
    const chain = new FakeChain()
    chain.height = 10
    chain.finalized = 8
    const driver = await start({
      chain,
      config: makeConfig({ observedResources: [W.loan] }),
      effects: effects({ broadcast: () => new Promise<never>(() => {}) })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0] !== undefined, 'an open record')
    await until(() => chain.capacityReads.includes('0x10A'), 'a read at the first tip')
    const latest = chain.latest
    chain.latest = async () => {
      const snapshot = await latest()
      chain.latest = latest
      chain.forkAt = 1
      chain.branch = 'B'
      chain.capacityReads = []
      return snapshot
    }
    await until(() => chain.capacityReads.includes('0x10B'), 'a read at the new tip')
    expect(chain.capacityReads).not.toContain('0x10A')
    expect(driver.alarms().some(a => a.startsWith('finality violated'))).toBe(true)
    await driver.abandon()
  })

  it('drops a nonce lookup whose vouch finds the finalized chain replaced', async () => {
    const chain = new FakeChain()
    chain.height = 10
    chain.finalized = 8
    const driver = await start({
      chain,
      effects: effects({ broadcast: () => new Promise<never>(() => {}) })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0] !== undefined, 'an open record')
    let overtaken = false
    chain.minedAt = { hash: '0xexec', block: 5, branch: 'A' }
    chain.beforeBlock = number => {
      if (overtaken || number !== 5) return Promise.resolve()
      overtaken = true
      chain.forkAt = 1
      chain.branch = 'B'
      chain.minedAt = undefined
      return Promise.resolve()
    }
    chain.nonce = 1
    await until(() => overtaken && driver.state().head?.hash === '0x10B', 'the overtaking reset')
    await sleep(50)
    expect(driver.state().nonces[0]).toBeDefined()
    expect(driver.state().nonces[0]?.resolution).toBeUndefined()
    await driver.abandon()
  })

  it('holds a simulation requested with no tip until a fresh head, instead of failing it', async () => {
    const chain = new FakeChain()
    chain.height = 10
    chain.finalized = 8
    const simulated: string[] = []
    const driver = await start({
      chain,
      effects: effects({
        signTyped: () => Promise.resolve('sig'),
        materialize: command =>
          Promise.resolve({ payload: publish(T, command.signatures[0]), witness: T }),
        simulate: (payload, at) => {
          simulated.push(`${fnOf(payload)}@${at.hash}`)
          return Promise.resolve(true)
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: ecrecoverPlan('q', T) })
    await until(
      () => driver.state().entries[midnightId('g1')]?.state === 'exposed',
      'an exposed offer'
    )
    chain.latestDelayMs = 100
    chain.forkAt = 1
    chain.branch = 'B'
    await until(() => driver.state().lifecycle.kind === 'recovering', 'recovery')
    const requests = driver.state().nextRequest
    await sleep(80)
    expect(driver.state().nextRequest - requests).toBeLessThanOrEqual(2)
    await until(
      () => simulated.includes('setConsumed@0x10B'),
      'the cancellation simulated at the fresh head'
    )
    await driver.abandon()
  })

  it('rolls back to a head behind its tip, so nothing is pinned to the block it lost', async () => {
    const chain = new FakeChain()
    chain.height = 10
    chain.finalized = 8
    const pinned: string[] = []
    const driver = await start({
      chain,
      effects: effects({
        simulate: (_, at) => {
          pinned.push(at.hash)
          return Promise.resolve(true)
        }
      })
    })
    await running(driver)
    chain.height = 9
    await until(() => driver.state().head?.number === 9, 'the retreat')
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => pinned.length > 0, 'a simulation')
    expect(pinned).toEqual(['0x9A'])
    await driver.abandon()
  })

  it('takes a newly finalized anchor from the branch it just delivered, not the one it replaced', async () => {
    const chain = new FakeChain()
    chain.height = 10
    chain.finalized = 8
    const driver = await start({ chain })
    await running(driver)
    chain.forkAt = 8
    chain.branch = 'B'
    chain.finalized = 9
    await until(() => driver.state().head?.hash === '0x10B', 'the shallow fork')
    chain.height = 11
    await until(() => driver.state().head?.hash === '0x11B', 'the next head')
    expect(driver.alarms()).toEqual([])
    await driver.abandon()
  })

  it('aborts a send still waiting past the dispatch window', async () => {
    const sent: string[] = []
    const driver = await start({
      config: makeConfig({ maxDispatchLagMs: 100 }),
      effectTimeoutMs: 1_000,
      effects: effects({
        broadcast: async (raw, guard) => {
          await sleep(200)
          if (!guard.mayAct()) throw new Error('withdrawn before sending')
          sent.push(raw)
          return 'accepted'
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0] !== undefined, 'the commit')
    await sleep(300)
    expect(sent).toEqual([])
    await driver.abandon()
  })

  it('withholds a neutral send when a halt lands while it waits to hand off', async () => {
    const sent: string[] = []
    const released = Promise.withResolvers<void>()
    const driver = await start({
      effects: effects({
        broadcast: async (raw, guard) => {
          await released.promise
          if (!guard.mayAct()) throw new Error('withdrawn before sending')
          sent.push(raw)
          return 'accepted'
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().plans.liq?.phase === 'expose', 'the dispatch')
    driver.send({ type: 'Halt', reason: 'operator' })
    released.resolve()
    await until(() => driver.state().nonces[0]?.candidates[0]?.sent === 'withheld', 'withheld')
    expect(sent).not.toContain('raw:exec')
    expect(driver.state().plans.liq?.reason).toBe(
      'withheld at handoff: lifecycle forbids this action'
    )
    await driver.abandon()
  })

  it('withholds a risk-increasing send whose evidence expired while it waited to hand off', async () => {
    const released = Promise.withResolvers<void>()
    const driver = await start({
      now: Date.now,
      effectTimeoutMs: 60_000,
      effects: effects({
        broadcast: async (_raw, guard) => {
          await released.promise
          if (!guard.mayAct()) throw new Error('withdrawn before sending')
          return 'accepted'
        }
      })
    })
    await running(driver)
    const notAfter = Date.now() + 1_000
    const ratified = tree(offer('g1', 300n, { ratifier: W.setter }))
    driver.send({
      type: 'Submit',
      plan: { ...setterPlan('q', ratified), notAfter }
    })
    await until(() => driver.state().plans.q?.phase === 'expose', 'the dispatch')
    await until(() => Date.now() > notAfter, 'the evidence to expire')
    released.resolve()
    await until(() => driver.state().nonces[0]?.candidates[0]?.sent === 'withheld', 'withheld')
    expect(driver.state().plans.q?.reason).toBe('withheld at handoff: evidence expired')
    await driver.abandon()
  })

  it('lets the re-send of a step that latched the kernel through the guard, past the dispatch window', async () => {
    const chain = new FakeChain()
    const handedOff: boolean[] = []
    const driver = await start({
      chain,
      config: makeConfig({ maxDispatchLagMs: 50, stuckBlocks: 1 }),
      effects: effects({
        broadcast: (_raw, guard) => {
          handedOff.push(guard.mayAct())
          return handedOff.length === 1
            ? Promise.reject(new Error('the connection dropped after the write'))
            : Promise.resolve('accepted')
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0]?.candidates[0]?.sent === 'unknown', 'unknown')
    await sleep(100)
    chain.height += 2
    await until(() => driver.state().nonces[0]?.candidates[0]?.sent === 'accepted', 'the re-send')
    expect(handedOff.length).toBeGreaterThan(1)
    expect(handedOff).not.toContain(false)
    await driver.abandon()
  })

  it('withholds the re-send of a step once a halt revokes it while it waits to hand off', async () => {
    const chain = new FakeChain()
    const handedOff: boolean[] = []
    const released = Promise.withResolvers<void>()
    const driver = await start({
      chain,
      config: makeConfig({ stuckBlocks: 1 }),
      effects: effects({
        broadcast: async (_raw, guard) => {
          if (handedOff.length > 0) await released.promise
          handedOff.push(guard.mayAct())
          if (handedOff.length === 1) throw new Error('the connection dropped after the write')
          return 'accepted'
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0]?.candidates[0]?.sent === 'unknown', 'unknown')
    chain.height += 2
    await until(
      () => Object.values(driver.state().outstanding).some(o => o.kind === 'broadcast'),
      'the re-send'
    )
    driver.send({ type: 'Halt', reason: 'operator' })
    released.resolve()
    await until(() => handedOff.length > 1, 'the handoff')
    expect(handedOff.slice(1)).not.toContain(true)
    await driver.abandon()
  })

  it('reports unknown, never withheld, once the guard has let a send go', async () => {
    const driver = await start({
      effects: effects({
        broadcast: (_raw, guard) => {
          guard.mayAct()
          return Promise.reject(new Error('the connection dropped after the write'))
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0]?.candidates[0]?.sent === 'unknown', 'unknown')
    await driver.abandon()
  })

  it('withholds a send that timed out before its guard ever let it go', async () => {
    const driver = await start({
      effectTimeoutMs: 50,
      effects: effects({ broadcast: () => new Promise(() => {}) })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0]?.candidates[0]?.sent === 'withheld', 'withheld')
    await driver.abandon()
  })

  it('closes the guard once its send settles', async () => {
    let kept: EffectGuard | undefined
    const driver = await start({
      effects: effects({
        broadcast: (_raw, guard) => {
          kept = guard
          return Promise.resolve('accepted')
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0]?.candidates[0]?.sent === 'accepted', 'accepted')
    expect(kept?.mayAct()).toBe(false)
    await driver.abandon()
  })

  it('refuses a send whose dispatch deadline passed while the event loop stalled', async () => {
    const sent: string[] = []
    const released = Promise.withResolvers<void>()
    const driver = await start({
      now: Date.now,
      config: makeConfig({ maxDispatchLagMs: 100 }),
      effectTimeoutMs: 1_000,
      effects: effects({
        broadcast: async (raw, guard) => {
          await released.promise
          if (!guard.mayAct()) throw new Error('withdrawn before sending')
          sent.push(raw)
          return 'accepted'
        }
      })
    })
    await running(driver)
    driver.send({
      type: 'Submit',
      plan: liquidationPlan('liq', { notAfter: Date.now() + 600_000 })
    })
    await until(() => driver.state().nonces[0] !== undefined, 'the commit')
    await sleep(20)
    released.resolve()
    const stalledUntil = Date.now() + 150
    while (Date.now() < stalledUntil) {
      // a synchronous stall: the abort timer cannot fire before the send resumes
    }
    await sleep(20)
    expect(sent).not.toContain('raw:exec')
    expect(driver.state().nonces[0]?.candidates[0]?.sent).toBe('withheld')
    await driver.abandon()
  })

  it('carries finality forward on an unchanged head, so a resolved record settles', async () => {
    const chain = new FakeChain()
    chain.height = 10
    chain.finalized = 8
    const driver = await start({ chain })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0] !== undefined, 'the broadcast')
    chain.receipts.set('0xexec', { block: 9, branch: 'A' })
    await until(() => driver.state().nonces[0]?.resolution !== undefined, 'the receipt')
    chain.finalized = 9
    await until(() => driver.state().nonces[0] === undefined, 'the record to settle')
    await driver.abandon()
  })

  it('hands out a copy of its state, so inspecting it cannot change the kernel', async () => {
    const driver = await start()
    await running(driver)
    const seen = driver.state()
    seen.lifecycle = { kind: 'stopped', outcome: 'clean', reason: 'edited by a caller' }
    expect(driver.state().lifecycle.kind).toBe('running')
    await driver.abandon()
  })

  it('carries no finality time before any anchor is proved', async () => {
    const chain = new FakeChain()
    chain.height = 30
    chain.finalized = 20
    chain.beforeBlock = number =>
      number === 20 ? Promise.reject(new Error('block 20 unavailable')) : Promise.resolve()
    const driver = await start({ chain, reorgDepth: 4 })
    await until(() => driver.state().head?.number === 30, 'the head')
    await sleep(30)
    expect(driver.state().finalized).toStrictEqual({ number: -1, timestamp: 0n })
    await driver.abandon()
  })

  it('holds finality back until the new anchor below its window is read and linked', async () => {
    const chain = new FakeChain()
    chain.height = 30
    chain.finalized = 5
    const driver = await start({ chain, reorgDepth: 4 })
    await running(driver)
    expect(driver.state().finalized.number).toBe(5)
    let unavailable = true
    chain.beforeBlock = number =>
      unavailable && number === 20
        ? Promise.reject(new Error('block 20 unavailable'))
        : Promise.resolve()
    chain.finalized = 20
    await sleep(50)
    expect(driver.state().finalized.number).toBe(5)
    unavailable = false
    await until(() => driver.state().finalized.number === 20, 'finality once the anchor reads')
    await driver.abandon()
  })

  it('keeps reading observations when a nonce lookup keeps failing', async () => {
    const chain = new FakeChain()
    chain.height = 10
    chain.finalized = 8
    chain.nonceTx = () => Promise.reject(new Error('lookup unavailable'))
    const driver = await start({
      chain,
      config: makeConfig({ observedResources: [W.loan] }),
      effects: effects({ broadcast: () => new Promise<never>(() => {}) })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0] !== undefined, 'an open record')
    chain.nonce = 1
    await sleep(30)
    chain.capacityReads = []
    await until(() => chain.capacityReads.length >= 3, 'capacity reads despite the lookup')
    await driver.abandon()
  })

  it('finishes a slow vouch inside its poll, so it never checks an anchor that moved on', async () => {
    const chain = new FakeChain()
    chain.height = 10
    chain.finalized = 8
    const driver = await start({ chain, effectTimeoutMs: 100 })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0] !== undefined, 'the broadcast')
    let vouching = false
    chain.beforeBlock = async number => {
      if (number === 5) {
        vouching = true
        chain.finalized = 9
        await sleep(60)
      } else if (number === 8 && vouching) {
        vouching = false
        await sleep(60)
      }
    }
    chain.receipts.set('0xexec', { block: 5, branch: 'A' })
    await until(() => driver.state().nonces[0] === undefined, 'the record to settle')
    await sleep(100)
    expect(driver.alarms()).toEqual([])
    await driver.abandon()
  })

  it('turns a store that throws synchronously into a failed flush', async () => {
    const store = new MemoryStore()
    store.write = () => {
      throw new Error('EIO')
    }
    const driver = await start({ store })
    await until(() => driver.state().lifecycle.kind !== 'starting', 'startup to resolve')
    expect(driver.alarms().length).toBeGreaterThan(0)
    await driver.abandon()
  })

  it('never delivers blocks that do not link, when the source changes forks mid-walk', async () => {
    const chain = new FakeChain()
    const errors: unknown[] = []
    const driver = await start({ chain, onError: (_, error) => errors.push(error) })
    await until(() => driver.state().head?.number === 1, 'the first head')
    chain.forkAt = 1
    chain.height = 3
    const latest = chain.latest
    chain.latest = async () => {
      const answer = await latest()
      chain.branch = chain.branch === 'A' ? 'B' : 'A'
      return answer
    }
    await until(() => errors.length > 0, 'a refused walk')
    expect(String(errors[0])).toMatch(/changed forks/)
    expect(driver.state().head?.number).toBe(1)
    await driver.abandon()
  })

  it('does not vouch for a final block once the finalized chain changed under it', async () => {
    const chain = new FakeChain()
    chain.height = 10
    chain.finalized = 8
    const driver = await start({ chain })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0] !== undefined, 'the broadcast')
    chain.receipts.set('0xexec', { block: 5, branch: 'B' })
    chain.onReceipt = () => {
      chain.branch = 'B'
    }
    await until(() => driver.alarms().some(a => a.startsWith('finality violated')), 'the alarm')
    expect(driver.state().nonces[0]).toBeDefined()
    expect(driver.state().nonces[0]?.resolution).toBeUndefined()
    await driver.abandon()
  })

  it('judges a late flush acknowledgement against the time it arrives', async () => {
    let clock = 0
    const store = new MemoryStore()
    const broadcasts: string[] = []
    const driver = await start({
      store,
      now: () => clock,
      pollMs: 60_000,
      effects: effects({
        broadcast: raw => {
          broadcasts.push(raw)
          return Promise.resolve('accepted')
        }
      })
    })
    await running(driver)
    const held = store.hold()
    driver.send({ type: 'Submit', plan: liquidationPlan('liq', { notAfter: 1_000_000 }) })
    await until(() => driver.state().nonces[0] !== undefined, 'the commit')
    clock = 10_000
    held.open()
    await sleep(50)
    expect(broadcasts).not.toContain('raw:exec')
    await driver.abandon()
  })

  it('reads the ledger before it polls, so a slow read cannot hide the first head', async () => {
    const store = new MemoryStore()
    const read = store.read
    store.read = async () => {
      await sleep(30)
      return read()
    }
    const driver = await start({ store })
    await until(() => driver.state().head?.number === 1, 'the first head')
    await driver.abandon()
  })

  it('keeps processing events after an effect throws synchronously', async () => {
    let clock = 0
    const driver = await start({
      now: () => (clock += 10),
      effects: effects({
        simulate: () => {
          throw new Error('synchronous')
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    const before = driver.state().now
    await sleep(50)
    expect(driver.state().now).toBeGreaterThan(before)
    await driver.abandon()
  })

  it('aborts an effect still waiting to act when abandoned', async () => {
    const sent: string[] = []
    const held = Promise.withResolvers<void>()
    let called = false
    const driver = await start({
      effects: effects({
        broadcast: async (raw, guard) => {
          called = true
          await held.promise
          if (!guard.mayAct()) throw new Error('withdrawn before sending')
          sent.push(raw)
          return 'accepted'
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => called, 'the broadcast to start')
    await driver.abandon()
    held.resolve()
    await sleep(20)
    expect(sent).toEqual([])
  })

  it('resolves abandon only once a write already handed to the store has settled', async () => {
    const store = new MemoryStore()
    const driver = await start({ store })
    await running(driver)
    const writing = store.hold()
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0] !== undefined, 'the commit flush')
    let abandoned = false
    const abandoning = driver.abandon().then(() => {
      abandoned = true
    })
    await sleep(20)
    expect(abandoned).toBe(false)
    writing.open()
    await abandoning
    expect(store.text).toContain('raw:exec')
  })
})

describe('the kernel on the engine', () => {
  it('judges a late effect result at the time its push arrives', async () => {
    let clock = 0
    const held = Promise.withResolvers<void>()
    const driver = await start({
      now: () => clock,
      pollMs: 60_000,
      effects: effects({ simulate: () => held.promise.then(() => true) })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().plans.liq?.phase === 'simulate', 'the simulation')
    expect(driver.state().now).toBe(0)
    clock = 5_000
    held.resolve()
    await until(() => driver.state().plans.liq?.phase !== 'simulate', 'the simulated result')
    expect(driver.state().now).toBe(5_000)
    await driver.abandon()
  })

  it('keeps observing, transitioning and recovering while the journal never acknowledges', async () => {
    const appended: JournalEntry[] = []
    const writing = Promise.withResolvers<void>()
    const chain = new FakeChain()
    const notices: string[] = []
    const driver = await start({
      chain,
      journal: journal(entry => {
        appended.push(entry)
        return writing.promise
      }),
      onActivity: onNotices(({ notice }) => void notices.push(notice))
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0] !== undefined, 'the broadcast')
    chain.receipts.set('0xexec', { block: 2, branch: 'A' })
    chain.height = 4
    chain.finalized = 3
    await until(() => notices.includes('settled'), 'the settlement')
    driver.send({ type: 'Halt', reason: 'operator' })
    expect(appended).toHaveLength(1)
    writing.resolve()
    await expect(driver.stopped).resolves.toMatchObject({ outcome: 'clean' })
    expect(appended.length).toBeGreaterThan(1)
  })

  it('halts into recovery when the journal overflows, refusing new acts while it withdraws', async () => {
    const sent: string[] = []
    const notices: string[] = []
    let holding = false
    const writing = Promise.withResolvers<void>()
    const driver = await start({
      journal: journal(() => (holding ? writing.promise : Promise.resolve()), 4_000),
      onActivity: onNotices(({ intentId, notice }) => void notices.push(`${intentId} ${notice}`)),
      effects: effects({
        signTyped: () => Promise.resolve('sig'),
        materialize: command =>
          Promise.resolve({ payload: publish(T, command.signatures[0]), witness: T }),
        broadcast: raw => {
          sent.push(raw)
          return Promise.resolve('accepted')
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: ecrecoverPlan('q', T) })
    await until(
      () => driver.state().entries[midnightId('g1')]?.state === 'exposed',
      'an exposed offer'
    )
    holding = true
    await until(() => driver.state().lifecycle.kind === 'recovering', 'recovery')
    expect(driver.alarms()).toContain('journal failed: JournalOverflowError')
    driver.send({ type: 'Submit', plan: liquidationPlan('late') })
    await until(() => notices.includes('late refused'), 'the refusal')
    await until(() => sent.includes('raw:setConsumed'), 'the withdrawal')
    writing.resolve()
    await expect(driver.abandon()).rejects.toBeInstanceOf(JournalOverflowError)
  })

  it('makes no chain read once abandoned, even in a poll that was waiting', async () => {
    const chain = new FakeChain()
    const driver = await start({ chain, config: makeConfig({ observedResources: [W.loan] }) })
    await running(driver)
    const held = Promise.withResolvers<void>()
    const latest = chain.latest
    chain.latest = async () => {
      await held.promise
      return latest()
    }
    await sleep(20)
    await driver.abandon()
    chain.capacityReads = []
    held.resolve()
    await sleep(20)
    expect(chain.capacityReads).toStrictEqual([])
  })

  it('replays its journal to the same derivations, the late-result ticks included, from the stamps', async () => {
    const entries: JournalEntry[] = []
    const chain = new FakeChain()
    let clock = 1_000
    const notices: string[] = []
    const driver = await start({
      chain,
      now: () => (clock += 7),
      journal: journal(entry => {
        entries.push(entry)
        return Promise.resolve()
      }),
      onActivity: onNotices(({ notice }) => void notices.push(notice))
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0] !== undefined, 'the broadcast')
    chain.receipts.set('0xexec', { block: 2, branch: 'A' })
    chain.height = 4
    chain.finalized = 3
    await until(() => notices.includes('settled'), 'the settlement')
    await driver.abandon()

    const refuse = () => {
      throw new Error('replay ran an effect')
    }
    const g = createGraph('kernel')
    declareKernel(g, {
      config: makeConfig({ maxDispatchLagMs: 5_000 }),
      store: { read: refuse, write: refuse },
      chain: new Proxy({} as KernelChain, { get: () => refuse }),
      effects: new Proxy({} as KernelEffects, { get: () => refuse }),
      enrollment: 'enrolling',
      pollMs: 5,
      effectTimeoutMs: 1_000,
      reorgDepth: 16,
      onError: refuse,
      onActivity: refuse
    })
    const graph = g.build()
    const steps = entries.filter(entry => entry.kind === 'step')
    expect(replay(graph, entries)).toStrictEqual({ ok: true, steps: steps.length })

    const late = steps.findIndex(entry =>
      entry.writes.some(w => w.node === 'kernel.effects.results')
    )
    const shifted = steps.map((entry, i) =>
      i === late ? { ...entry, stamp: { ...entry.stamp, at: entry.stamp.at + 1 } } : entry
    )
    expect(replay(graph, shifted)).toStrictEqual({
      ok: false,
      step: late + 1,
      reason: 'derived writes differ'
    })
  })

  it('journals each handoff guard verdict with the time it observed', async () => {
    const entries: JournalEntry[] = []
    let clock = 0
    const driver = await start({
      now: () => clock,
      journal: journal(entry => {
        entries.push(entry)
        return Promise.resolve()
      }),
      effects: effects({
        broadcast: (_raw, guard) => {
          clock = 42
          return Promise.resolve(guard.mayAct() ? 'accepted' : 'rejected')
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => driver.state().nonces[0]?.candidates[0]?.sent === 'accepted', 'the send')
    await driver.abandon()
    const notes = entries.flatMap(entry => (entry.kind === 'note' ? [entry] : []))
    expect(notes).toStrictEqual([
      {
        kind: 'note',
        effect: 'kernel.executor',
        at: 42,
        note: { guard: 'handoff', request: expect.any(Number), observedAt: 42, verdict: 'act' }
      }
    ])
  })

  it('refuses a handoff when journaling its own verdict halts the kernel', async () => {
    let holding = false
    const writing = Promise.withResolvers<void>()
    let driver: Awaited<ReturnType<typeof start>> | undefined
    const verdicts: boolean[] = []
    driver = await start({
      pollMs: 60_000,
      journal: journal(() => (holding ? writing.promise : Promise.resolve()), 8_000),
      effects: effects({
        broadcast: async (_raw, guard) => {
          if (verdicts.length > 0) return 'accepted'
          holding = true
          driver?.send({ type: 'Affirm', ids: [] })
          await sleep(0)
          for (let i = 0; i < 100 && driver?.state().lifecycle.kind === 'running'; i++)
            driver.send({ type: 'Affirm', ids: [] })
          verdicts.push(guard.mayAct())
          throw new Error('withdrawn before sending')
        }
      })
    })
    await running(driver)
    driver.send({ type: 'Submit', plan: liquidationPlan('liq') })
    await until(() => verdicts.length > 0, 'the handoff')
    expect(verdicts).toStrictEqual([false])
    expect(driver.state().lifecycle.kind).toBe('recovering')
    await until(() => driver.state().nonces[0]?.candidates[0]?.sent === 'withheld', 'withheld')
    writing.resolve()
    await expect(driver.abandon()).rejects.toBeInstanceOf(JournalOverflowError)
  })

  it('keeps recovering through a burst of 500 submissions', async () => {
    const sent: string[] = []
    const { runner, nodes } = await startKernel({
      config: makeConfig({ maxDispatchLagMs: 5_000 }),
      store: new MemoryStore(),
      chain: new FakeChain(),
      enrollment: 'enrolling',
      pollMs: 5,
      effectTimeoutMs: 1_000,
      reorgDepth: 16,
      onError: () => {},
      now: () => 0,
      journal: journal(async () => undefined),
      effects: effects({
        signTyped: () => Promise.resolve('sig'),
        materialize: command =>
          Promise.resolve({ payload: publish(T, command.signatures[0]), witness: T }),
        broadcast: raw => {
          sent.push(raw)
          return Promise.resolve('accepted')
        }
      })
    })
    const state = () => runner.read(nodes.state)!
    await until(() => state().lifecycle.kind === 'running', 'running')
    runner.push(unauthored(nodes.requests), { type: 'Submit', plan: ecrecoverPlan('q', T) })
    await until(() => state().entries[midnightId('g1')]?.state === 'exposed', 'an exposed offer')
    runner.pushAll(
      Array.from({ length: 500 }, (_, i) =>
        sourceWrite(unauthored(nodes.requests), {
          type: 'Submit',
          plan: liquidationPlan(`liq${i}`)
        })
      )
    )
    runner.push(nodes.requests, { type: 'Halt', reason: 'operator' })
    await until(() => sent.includes('raw:setConsumed'), 'the withdrawal')
    await runner.abandon()
  })

  it('reports nothing from a poll still waiting when it is abandoned', async () => {
    const chain = new FakeChain()
    const errors: string[] = []
    const driver = await start({
      chain,
      effectTimeoutMs: 50,
      onError: source => errors.push(source)
    })
    await running(driver)
    chain.latest = () => new Promise(() => {})
    await sleep(20)
    await driver.abandon()
    await sleep(100)
    expect(errors).toStrictEqual([])
  })
})

describe('kernels in one process', () => {
  const options = (chain: FakeChain, overrides: Partial<KernelHostOptions> = {}) => ({
    config: makeConfig({ maxDispatchLagMs: 5_000 }),
    store: new MemoryStore(),
    chain,
    effects: effects(),
    enrollment: 'enrolling' as const,
    pollMs: 5,
    effectTimeoutMs: 200,
    reorgDepth: 16,
    onError: () => {},
    now: () => 0,
    ...overrides
  })

  it('refuses a host that does not say where its failed reads and effects go', () => {
    const { onError: _, ...unstated } = options(new FakeChain())
    // @ts-expect-error a host without onError is refused
    const host: KernelHostOptions = unstated
    expect(host).toBeDefined()
  })

  it('refuses to start without a journal before pushing Start', async () => {
    const g = createGraph('bot')
    const kernel = declareKernel(g, options(new FakeChain()))
    const runner = createRunner(g.build(), { now: () => 0 })

    await expect(kernel.start(runner)).rejects.toBeInstanceOf(KernelJournalRequiredError)
    expect(runner.read(kernel.nodes.state)?.lifecycle.kind).toBe('idle')
    await runner.abandon()
  })

  it('halts and stops cleanly when a bot operator fails in the step that starts it', async () => {
    const g = createGraph('bot')
    const kernel = declareKernel(g, options(new FakeChain()))
    g.map('bot.view', {
      reads: { state: latest(kernel.nodes.state) },
      compute: ({ state }) => {
        if (state.lifecycle.kind !== 'idle') throw new Error('the view failed')
        return state.lifecycle.kind
      }
    })
    const runner = createRunner(g.build(), {
      now: () => 0,
      journal: journal(async () => undefined)
    })
    await kernel.start(runner)

    const error = await runner.stopped.catch((value: unknown) => value)
    expect(error).toBeInstanceOf(GraphFailedError)
    expect(error).toMatchObject({
      origin: 'bot.view',
      stop: { type: 'report', outcome: 'clean', reason: 'bot.view failed: Error' }
    })
  })

  it('refuses a second kernel in one graph, until a composite stop and startup exist', () => {
    const g = createGraph('bot')
    declareKernel(g, options(new FakeChain()))
    g.scope('mainnet', scope => declareKernel(scope, options(new FakeChain())))
    expect(() => g.build()).toThrow(
      new GraphDefinitionError('bot declares 2 recovery scopes; a graph holds one')
    )
  })

  it('declares its nodes, folds, effects and recovery scope under stable ids', () => {
    const g = createGraph('bot')
    declareKernel(g, options(new FakeChain()))
    const graph = layoutOf(g.build())
    expect({
      nodes: [...graph.nodes.keys()],
      operators: graph.operators.map(op => op.id),
      effects: graph.effects.map(effect => effect.id),
      recovery: graph.recoveries.map(recovery => recovery.members.toSorted())
    }).toStrictEqual({
      nodes: [
        'kernel.start',
        'kernel.requests',
        'kernel.tick',
        'kernel.chain.events',
        'kernel.effects.results',
        'kernel.observed',
        'kernel.in',
        'kernel.commands',
        'kernel.lookups',
        'kernel.activity',
        'kernel.heads',
        'kernel.observe',
        'kernel.merge',
        'kernel.state'
      ],
      operators: ['kernel.observe', 'kernel.merge', 'kernel.state'],
      effects: ['kernel.listener', 'kernel.executor', 'kernel.chain'],
      recovery: [
        [
          'kernel.chain',
          'kernel.executor',
          'kernel.listener',
          'kernel.merge',
          'kernel.observe',
          'kernel.state',
          'kernel.tick'
        ]
      ]
    })
  })

  it('both attach paths route a key holding / to its registered fact node', async () => {
    const run = async (split: boolean) => {
      const g = createGraph('bot')
      const writes = g.occurrences<KeyedWrite<{ open: boolean }>>('positions.writes')
      const positions = keyedLevel(g, 'positions', writes)
      const notices: string[] = []
      const hosting = {
        ...options(new FakeChain()),
        onActivity: (activity: readonly KernelActivity[]) => {
          for (const a of activity)
            if (a.type === 'notice') notices.push(`${a.intentId}:${a.notice}`)
        }
      }
      const lifecycle = (kernel: { nodes: { state: State<KernelState> } }) =>
        g.map('bot.lifecycle', {
          reads: { state: latest(kernel.nodes.state) },
          compute: ({ state }) => state.lifecycle.kind
        })
      let kernel
      if (split) {
        const host = declareKernelHost(g, hosting)
        lifecycle(host)
        host.attach({ facts: [positions] })
        kernel = host
      } else {
        kernel = declareKernel(g, { ...hosting, facts: [positions] })
        lifecycle(kernel)
      }
      const graph = g.build()
      const journal: JournalEntry[] = []
      const runner = createRunner(graph, {
        now: () => 0,
        journal: {
          sink: {
            append: async entry => void journal.push(entry),
            finalize: async () => undefined
          },
          capacityBytes: 1_000_000
        }
      })
      await kernel.start(runner)
      const state = () => runner.read(kernel.nodes.state)!
      await until(() => state().lifecycle.kind === 'running', 'running')
      const basis = { block: 1, blockHash: '0x1A' }
      runner.push(writes, { coverage: 'complete', entries: { 'p/1': { open: true } }, basis })
      const p1 = runner.read(positions)!.keys['p/1']!
      runner.push(unauthored(kernel.nodes.requests), {
        type: 'Submit',
        plan: liquidationPlan('liq', {
          evidence: [
            {
              id: factId('positions', 'p/1'),
              version: p1.status === 'present' ? p1.digest : '',
              basis
            }
          ],
          notAfter: FRESH_UNTIL
        })
      })
      await until(() => notices.includes('liq:admitted'), 'the plan to be admitted')
      await runner.abandon()
      return { graph, journal, notices, effects: layoutOf(graph).effects.map(effect => effect.id) }
    }
    const whole = await run(false)
    const split = await run(true)
    expect(split.notices).toStrictEqual(whole.notices)
    expect(split.effects).toStrictEqual(whole.effects)
    expect(replay(split.graph, whole.journal).ok).toBe(true)
    expect(replay(whole.graph, split.journal).ok).toBe(true)
  })

  it('refuses a kernel declared in two steps that is never attached, or attached twice', () => {
    const g = createGraph('bot')
    const host = declareKernelHost(g, options(new FakeChain()))
    expect(() => g.build()).toThrow(
      new GraphDefinitionError('node kernel.observe is reserved but no fold produces it')
    )
    host.attach({})
    expect(() => host.attach({})).toThrow(new GraphDefinitionError('the kernel is attached twice'))
  })

  it.each(['declareKernel', 'host.attach'] as const)(
    'refuses a fact node holding / through %s',
    attach => {
      const g = createGraph('bot')
      const writes = g.occurrences<KeyedWrite<{ open: boolean }>>('positions.writes')
      const fact = keyedLevel(g, 'positions/open', writes)
      const hosting = options(new FakeChain())

      expect(() => {
        if (attach === 'declareKernel') declareKernel(g, { ...hosting, facts: [fact] })
        else declareKernelHost(g, hosting).attach({ facts: [fact] })
      }).toThrow(new GraphDefinitionError("fact node positions/open may not contain '/'"))
    }
  )

  it('carries each plan its facts, and signs nothing once one changes before the signer signs', async () => {
    const g = createGraph('bot')
    const writes = g.occurrences<KeyedWrite<{ open: boolean }>>('positions.writes')
    const positions = keyedLevel(g, 'positions', writes)
    const held = Promise.withResolvers<void>()
    const signed: string[] = []
    const notes: unknown[] = []
    const kernel = declareKernel(g, {
      ...options(new FakeChain()),
      facts: [positions],

      effects: effects({
        signTx: async (payload, _candidate, guard) => {
          await held.promise
          if (!guard.mayAct()) throw new Error('withdrawn before signing')
          signed.push(payload.data)
          return { hash: '0xexec', raw: 'raw:exec' }
        }
      })
    })
    const runner = createRunner(g.build(), {
      now: () => 0,
      journal: {
        sink: {
          append: entry => {
            if (entry.kind === 'note') notes.push(entry.note)
            return Promise.resolve()
          },
          finalize: async () => undefined
        },
        capacityBytes: 1_000_000
      }
    })
    await kernel.start(runner)
    const state = () => runner.read(kernel.nodes.state)!
    await until(() => state().lifecycle.kind === 'running', 'running')
    const basis = { block: 1, blockHash: '0x1A' }
    runner.push(writes, { coverage: 'complete', entries: { p1: { open: true } }, basis })
    const p1 = runner.read(positions)!.keys.p1!
    const id = factId('positions', 'p1')
    runner.push(unauthored(kernel.nodes.requests), {
      type: 'Submit',
      plan: liquidationPlan('liq', {
        evidence: [{ id, version: p1.status === 'present' ? p1.digest : '', basis }],
        conflicts: { writes: ['position:p1'] },
        notAfter: FRESH_UNTIL
      })
    })
    expect(state().plans.liq?.status).toBe('executing')
    await until(() => state().plans.liq?.phase === 'sign', 'the signer')
    runner.push(writes, { coverage: 'complete', entries: {}, basis, empty: true })
    expect(state().observations[id]).toStrictEqual({ id, version: 'absent' })
    held.resolve()
    await until(() => state().plans.liq === undefined, 'the plan to end')
    expect(signed).toStrictEqual([])
    expect(notes).toContainEqual(
      expect.objectContaining({ guard: 'sign', verdict: `evidence ${id} changed` })
    )
    expect(state().nonces).toStrictEqual({})
    await runner.abandon()
  })

  it('tells the kernel when a fact known absent becomes unknown, though a duplicate was refused', async () => {
    const g = createGraph('bot')
    const raw = g.level<Keyed<{ open: boolean }>>('positions.raw')
    const positions = keyedMap(g, 'positions', raw, value => value)
    const held = Promise.withResolvers<void>()
    const kernel = declareKernel(g, {
      ...options(new FakeChain()),
      facts: [positions],
      effects: effects({ simulate: () => held.promise.then(() => true) })
    })
    const runner = createRunner(g.build(), {
      now: () => 0,
      journal: journal(async () => undefined)
    })
    await kernel.start(runner)
    const state = () => runner.read(kernel.nodes.state)!
    await until(() => state().lifecycle.kind === 'running', 'running')
    const basis = { block: 1, blockHash: '0x1A' }
    runner.push(raw, {
      value: { coverage: { status: 'complete' }, absentBasis: basis, keys: {} },
      basis
    })
    const id = factId('positions', 'gone')
    runner.push(unauthored(kernel.nodes.requests), {
      type: 'Submit',
      plan: liquidationPlan('rests on absence', {
        evidence: [{ id, version: 'absent', basis }],
        notAfter: FRESH_UNTIL
      })
    })
    expect(state().observations[id]).toStrictEqual({ id, version: 'absent' })
    runner.push(unauthored(kernel.nodes.requests), {
      type: 'Submit',
      plan: liquidationPlan('rests on absence', {
        evidence: [{ id, version: 'absent', basis }],
        notAfter: FRESH_UNTIL
      })
    })
    expect(state().plans['rests on absence']?.status).toBe('executing')
    runner.push(raw, { status: 'failed', reason: 'rpc' })
    expect(state().observations[id]).toStrictEqual({ id, unavailable: 'failed' })
    held.resolve()
    await until(() => state().plans['rests on absence'] === undefined, 'the refusal')
    expect(state().nonces).toStrictEqual({})
    await runner.abandon()
  })

  it('holds a plan to a wall-clock expiry a whole-node input sets, refuses at it, and replays the same deadlines', async () => {
    const start = 1_700_000_000_000
    let clock = start
    /** Positions listed until the listing's `validUntil`, a wall-clock time in milliseconds. */
    const bot = (overrides: Partial<KernelHostOptions>) => {
      const g = createGraph('bot')
      const writes = g.occurrences<KeyedWrite<{ open: boolean }>>('positions.writes')
      const positions = keyedLevel(g, 'positions', writes)
      const listing = g.level<{ validUntil: number }>('listing')
      const listed = keyedMap(g, 'listed', positions, () => true, {
        with: { listing: latest(listing) },
        expiry: (_value, _key, inputs) => inputs.listing.validUntil
      })
      const kernel = declareKernel(g, {
        ...options(new FakeChain(), { now: () => clock }),
        facts: [listed],
        ...overrides
      })
      return { g, writes, listing, listed, kernel }
    }
    const held = Promise.withResolvers<void>()
    const entries: JournalEntry[] = []
    const reasons: (string | undefined)[] = []
    const { g, writes, listing, listed, kernel } = bot({
      effects: effects({ simulate: () => held.promise.then(() => true) }),
      onActivity: onNotices(({ reason }) => void reasons.push(reason))
    })
    const runner = createRunner(g.build(), {
      now: () => clock,
      journal: {
        sink: {
          append: entry => {
            entries.push(entry)
            return Promise.resolve()
          },
          finalize: async () => undefined
        },
        capacityBytes: 1_000_000
      }
    })
    await kernel.start(runner)
    const state = () => runner.read(kernel.nodes.state)!
    await until(() => state().lifecycle.kind === 'running', 'running')
    const basis = { block: 1, blockHash: '0x1A' }
    const elsewhere = { block: 9_000_000, blockHash: '0xother' }
    runner.push(listing, { value: { validUntil: start + 60_000 }, basis: elsewhere })
    runner.push(writes, { coverage: 'complete', entries: { p1: { open: true } }, basis })
    const p1 = runner.read(listed)!.keys.p1!
    expect(p1).toMatchObject({ basis, expiry: start + 60_000 })
    const id = factId('listed', 'p1')
    runner.push(unauthored(kernel.nodes.requests), {
      type: 'Submit',
      plan: liquidationPlan('liq', {
        evidence: [{ id, version: p1.status === 'present' ? p1.digest : '', basis }],
        notAfter: start + 3_600_000
      })
    })
    expect(state().plans.liq?.notAfter).toBe(start + 60_000)
    runner.push(listing, { value: { validUntil: start + 1_000 }, basis: elsewhere })
    expect(state().observations[id]).toMatchObject({ expiry: start + 1_000 })
    expect(state().plans.liq?.notAfter).toBe(start + 1_000)
    clock = start + 1_000
    await until(() => state().now >= start + 1_000, 'the clock')
    expect(state().head!.number).toBeLessThan(start)
    held.resolve()
    await until(() => state().plans.liq === undefined, 'the refusal')
    expect(reasons.at(-1)).toBe('evidence expired')
    expect(state().nonces).toStrictEqual({})
    await runner.abandon()

    const refuse = () => {
      throw new Error('replay ran an effect')
    }
    const replayed = bot({
      store: { read: refuse, write: refuse },
      chain: new Proxy({} as KernelChain, { get: () => refuse }),
      effects: new Proxy({} as KernelEffects, { get: () => refuse })
    })
    const steps = entries.filter(entry => entry.kind === 'step')
    expect(replay(replayed.g.build(), entries)).toStrictEqual({ ok: true, steps: steps.length })
  })

  it('keeps a plan subscribed when a refused submission of its intent came first in a batch', async () => {
    const g = createGraph('bot')
    const raw = g.level<Keyed<{ open: boolean }>>('positions.raw')
    const positions = keyedMap(g, 'positions', raw, value => value)
    const held = Promise.withResolvers<void>()
    const kernel = declareKernel(g, {
      ...options(new FakeChain()),
      facts: [positions],
      effects: effects({ simulate: () => held.promise.then(() => true) })
    })
    const runner = createRunner(g.build(), {
      now: () => 0,
      journal: journal(async () => undefined)
    })
    await kernel.start(runner)
    const state = () => runner.read(kernel.nodes.state)!
    await until(() => state().lifecycle.kind === 'running', 'running')
    const basis = { block: 1, blockHash: '0x1A' }
    runner.push(raw, {
      value: { coverage: { status: 'complete' }, absentBasis: basis, keys: {} },
      basis
    })
    const id = factId('positions', 'gone')
    const unrecognized = encodeCall('0xNowhere', 'exec', { tag: 'x' })
    runner.pushAll([
      sourceWrite(unauthored(kernel.nodes.requests), {
        type: 'Submit',
        plan: { ...liquidationPlan('liq'), steps: [{ kind: 'tx', payload: unrecognized }] }
      }),
      sourceWrite(unauthored(kernel.nodes.requests), {
        type: 'Submit',
        plan: liquidationPlan('liq', {
          evidence: [{ id, version: 'absent', basis }],
          notAfter: FRESH_UNTIL
        })
      })
    ])
    expect(state().plans.liq?.status).toBe('executing')
    runner.push(raw, { status: 'failed', reason: 'rpc' })
    expect(state().observations[id]).toStrictEqual({ id, unavailable: 'failed' })
    held.resolve()
    await runner.abandon()
  })

  it('answers a submission the kernel took before it started, so a later duplicate cannot unsubscribe a live plan', async () => {
    const g = createGraph('bot')
    const raw = g.level<Keyed<{ open: boolean }>>('positions.raw')
    const positions = keyedMap(g, 'positions', raw, value => value)
    const held = Promise.withResolvers<void>()
    const kernel = declareKernel(g, {
      ...options(new FakeChain()),
      facts: [positions],
      effects: effects({ simulate: () => held.promise.then(() => true) })
    })
    const runner = createRunner(g.build(), {
      now: () => 0,
      journal: journal(async () => undefined)
    })
    const basis = { block: 1, blockHash: '0x1A' }
    const early = factId('positions', 'early')
    runner.push(unauthored(kernel.nodes.requests), {
      type: 'Submit',
      plan: liquidationPlan('liq', {
        evidence: [{ id: early, version: 'absent', basis }],
        notAfter: FRESH_UNTIL
      })
    })
    await kernel.start(runner)
    const state = () => runner.read(kernel.nodes.state)!
    await until(() => state().lifecycle.kind === 'running', 'running')
    runner.push(raw, {
      value: { coverage: { status: 'complete' }, absentBasis: basis, keys: {} },
      basis
    })
    const id = factId('positions', 'gone')
    const live = liquidationPlan('liq', {
      evidence: [{ id, version: 'absent', basis }],
      notAfter: FRESH_UNTIL
    })
    runner.push(unauthored(kernel.nodes.requests), { type: 'Submit', plan: live })
    runner.push(unauthored(kernel.nodes.requests), { type: 'Submit', plan: liquidationPlan('liq') })
    expect(state().plans.liq?.status).toBe('executing')
    runner.push(raw, { status: 'failed', reason: 'rpc' })
    expect(state().observations[id]).toStrictEqual({ id, unavailable: 'failed' })
    held.resolve()
    await runner.abandon()
  })

  it('halts a kernel composed into a bot graph into recovery when the journal fails', async () => {
    const g = createGraph('bot')
    const alarms: string[] = []
    const kernel = declareKernel(
      g,
      options(new FakeChain(), { onActivity: activity => alarms.push(...alarmsIn(activity)) })
    )
    let failing = false
    const runner = createRunner(g.build(), {
      now: () => 0,
      journal: {
        sink: {
          append: () => (failing ? Promise.reject(new Error('disk')) : Promise.resolve()),
          finalize: async () => undefined
        },
        capacityBytes: 1_000_000
      }
    })
    const stopped = runner.stopped.catch((error: unknown) => error)
    await kernel.start(runner)
    const state = () => runner.read(kernel.nodes.state)!
    await until(() => state().lifecycle.kind === 'running', 'running')
    failing = true
    runner.push(kernel.nodes.requests, { type: 'Affirm', ids: [] })
    expect(await stopped).toMatchObject({
      origin: 'journal',
      stop: { type: 'report', outcome: 'clean', reason: 'journal failed: JournalFailedError' }
    })
    expect(alarms).toContain('journal failed: JournalFailedError')
  })

  it('lets one chain settle and stop cleanly while another chain in the process stalls', async () => {
    const settled: string[] = []
    const first = new FakeChain()
    const second = new FakeChain()
    const run = (chain: FakeChain, overrides: Partial<KernelHostOptions> = {}) => {
      const g = createGraph('chain')
      const kernel = declareKernel(g, { ...options(chain), ...overrides })
      const runner = createRunner(g.build(), {
        now: () => 0,
        journal: journal(async () => undefined)
      })
      return { kernel, runner, state: () => runner.read(kernel.nodes.state)! }
    }
    const a = run(first, { onActivity: onNotices(({ notice }) => void settled.push(notice)) })
    const b = run(second)
    await a.kernel.start(a.runner)
    await b.kernel.start(b.runner)
    await until(
      () => a.state().lifecycle.kind === 'running' && b.state().lifecycle.kind === 'running',
      'both running'
    )
    second.latest = () => new Promise(() => {})
    a.runner.push(unauthored(a.kernel.nodes.requests), {
      type: 'Submit',
      plan: liquidationPlan('liq')
    })
    await until(() => a.state().nonces[0]?.candidates[0]?.sent === 'accepted', 'the send')
    first.receipts.set('0xexec', { block: 2, branch: 'A' })
    first.height = 4
    first.finalized = 3
    await until(() => settled.includes('settled'), 'the settlement')
    expect(a.runner.read(a.kernel.nodes.heads)).toStrictEqual({ number: 4, hash: '0x4A' })
    a.runner.push(a.kernel.nodes.requests, { type: 'Halt', reason: 'operator' })
    await expect(a.runner.stopped).resolves.toMatchObject({ type: 'report', outcome: 'clean' })
    expect(b.state().head?.number).toBe(1)
    await b.runner.abandon()
  })
})
