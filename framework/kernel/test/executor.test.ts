import { createGraph, createRunner, every, lane, sourceWrite } from '@repo/engine'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'

import type { KernelEffects, GuardVerdict } from '../src/executor'
import type { Command, KernelEvent, KernelState, Plan } from '../src/types'

import { createExecutor } from '../src/executor'
import { createKernel } from '../src/kernel'
import { FRESH_UNTIL, liquidationPlan, makeConfig } from './fixtures'
import { Harness } from './harness'

const config = makeConfig()

const SIGN: Command = {
  type: 'sign',
  request: 1,
  intentId: 'q',
  payload: { kind: 'typed', domain: {}, types: {}, primaryType: 'OfferTree', message: {} }
}

/** Runs one typed signature under `signal`, recording what the executor writes back. */
const signUnder = (signal: AbortSignal) => {
  const signTyped = vi.fn<KernelEffects['signTyped']>(() => Promise.resolve('sig'))
  const written: KernelEvent[] = []
  const executor = createExecutor({
    config,
    kernel: createKernel(config),
    store: { read: () => Promise.resolve(null), write: () => Promise.resolve() },
    effects: { signTyped } as unknown as KernelEffects,
    effectTimeoutMs: 1_000,
    onError: () => {}
  })
  const settled = executor.execute(SIGN, {
    signal,
    emittedAt: 0,
    now: () => 0,
    write: event => void written.push(event),
    note: () => {},
    state: () => createKernel(config).initialState(),
    stop: () => {}
  })
  return { signTyped, written, settled }
}

describe('the executor', () => {
  it('signs nothing when journaling the signing verdict halts the kernel', async () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    const [command] = h.pending('sign')
    const verdicts: string[] = []
    const signed: string[] = []
    const executor = createExecutor({
      config: h.config,
      kernel: createKernel(h.config),
      store: { read: () => Promise.resolve(null), write: () => Promise.resolve() },
      effects: {
        signTx: (_payload, _candidate, guard) => {
          if (!guard.mayAct()) return Promise.reject(new Error('withdrawn'))
          signed.push('liq')
          return Promise.resolve({ hash: '0xliq', raw: 'raw' })
        }
      } as KernelEffects,
      effectTimeoutMs: 1_000,
      onError: () => {}
    })
    await executor.execute(command!, {
      signal: new AbortController().signal,
      emittedAt: 0,
      now: () => h.now,
      write: () => {},
      note: verdict => {
        verdicts.push(verdict.verdict)
        if (verdicts.length === 1) h.send({ type: 'Halt', reason: 'journal overflow' })
      },
      state: () => h.state,
      stop: () => {}
    })
    expect(signed).toStrictEqual([])
    expect(verdicts).toStrictEqual(['act', 'the request was withdrawn'])
  })

  it('asks the kernel before the signer signs, and signs nothing once a fact changed', async () => {
    const h = new Harness().start()
    const fact = {
      id: 'liquidatable/p1',
      version: 'v1',
      basis: { block: h.block, blockHash: h.hash(h.block) }
    }
    h.send({
      type: 'Submit',
      plan: liquidationPlan('liq', { evidence: [fact], notAfter: FRESH_UNTIL }),
      observations: [fact]
    })
    h.simulate()
    const [command] = h.pending('sign')
    const verdicts: GuardVerdict[] = []
    const written: KernelEvent[] = []
    const signed: string[] = []
    const executor = createExecutor({
      config: h.config,
      kernel: createKernel(h.config),
      store: { read: () => Promise.resolve(null), write: () => Promise.resolve() },
      effects: {
        signTx: (_payload, _candidate, guard) => {
          if (!guard.mayAct()) return Promise.reject(new Error('withdrawn'))
          signed.push('liq')
          return Promise.resolve({ hash: '0xliq', raw: 'raw' })
        }
      } as KernelEffects,
      effectTimeoutMs: 1_000,
      onError: () => {}
    })
    const port = {
      signal: new AbortController().signal,
      emittedAt: 0,
      now: () => h.now,
      write: (event: KernelEvent) => void written.push(event),
      note: (verdict: GuardVerdict) => void verdicts.push(verdict),
      state: () => h.state,
      stop: () => {}
    }
    h.send({ type: 'Observed', observations: [{ ...fact, version: 'v2' }] })
    await executor.execute(command!, port)
    expect(signed).toStrictEqual([])
    expect(written).toStrictEqual([{ type: 'EffectFailed', request: command!.request }])
    expect(verdicts).toStrictEqual([
      {
        guard: 'sign',
        request: command!.request,
        observedAt: h.now,
        verdict: 'evidence liquidatable/p1 changed'
      }
    ])
  })

  it('invokes no effect for a command whose runner already stopped', async () => {
    const { signTyped, written, settled } = signUnder(AbortSignal.abort())
    await settled
    expect(signTyped).not.toHaveBeenCalled()
    expect(written).toStrictEqual([])
  })

  it('invokes no effect when the runner stops before the effect would start', async () => {
    const controller = new AbortController()
    const { signTyped, written, settled } = signUnder(controller.signal)
    controller.abort()
    await settled
    await sleep(0)
    expect(signTyped).not.toHaveBeenCalled()
    expect(written).toStrictEqual([])
  })

  it('classes a send by the plan its request belongs to, so a recovery send keeps its reserve', () => {
    const executor = createExecutor({
      config,
      kernel: createKernel(config),
      store: { read: () => Promise.resolve(null), write: () => Promise.resolve() },
      effects: {} as KernelEffects,
      effectTimeoutMs: 1_000,
      onError: () => {}
    })
    const state: KernelState = {
      ...createKernel(config).initialState(),
      outstanding: {
        1: { kind: 'broadcast', plan: 'fill' },
        2: { kind: 'release', plan: 'quote' }
      },
      plans: {
        fill: { recovery: { kind: 'fill', targetNonce: 0 } } as Plan,
        quote: {} as Plan
      }
    }
    const broadcast = (request: number): Command => ({
      type: 'broadcast',
      request,
      hash: '0x',
      raw: '0x'
    })
    expect(executor.recovery(broadcast(1), state)).toBe(true)
    expect(
      executor.recovery(
        { type: 'release', request: 2, payload: { kind: 'release', channel: 'api', message: {} } },
        state
      )
    ).toBe(false)
  })

  it('admits a recovery broadcast into a lane whose normal queue is full', async () => {
    const executor = createExecutor({
      config,
      kernel: createKernel(config),
      store: { read: () => Promise.resolve(null), write: () => Promise.resolve() },
      effects: {} as KernelEffects,
      effectTimeoutMs: 1_000,
      onError: () => {}
    })
    const g = createGraph('sends')
    const commands = g.occurrences<Command>('commands')
    const kernelState = g.level<KernelState>('state')
    const started: number[] = []
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    g.effect('send', {
      requests: { command: every(commands) },
      samples: { kernelState },
      lane: lane('sends', { concurrency: 1, queue: 1 }),
      recovery: ({ value }, samples) => executor.recovery(value, samples.kernelState()!),
      handle: async ({ value: command }) => {
        if (command.type === 'broadcast') started.push(command.request)
        await held
      }
    })
    const runner = createRunner(g.build())
    const broadcast = (request: number): Command => ({
      type: 'broadcast',
      request,
      hash: '0x',
      raw: '0x'
    })
    runner.push(kernelState, {
      basis: 0,
      value: {
        ...createKernel(config).initialState(),
        outstanding: {
          1: { kind: 'broadcast', plan: 'fill' },
          3: { kind: 'broadcast', plan: 'liq' },
          4: { kind: 'broadcast', plan: 'liq' }
        },
        plans: { fill: { recovery: { kind: 'fill', targetNonce: 0 } } as Plan, liq: {} as Plan }
      }
    })
    runner.push(commands, broadcast(3))
    runner.pushAll([sourceWrite(commands, broadcast(4)), sourceWrite(commands, broadcast(1))])
    release()
    await sleep(0)
    expect(started).toStrictEqual([3, 1, 4])
    await runner.abandon()
  })
})
