import type { KeyedWrite } from '@repo/engine'
import type { KernelRequest, KernelState, Validator } from '@repo/kernel'

import { createGraph, createRunner, every, keyedLevel, latest } from '@repo/engine'
import { declareKernel, factId } from '@repo/kernel'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'

import type { WorkflowEvent } from '../src'

import { act, declareWorkflow, factOf, kernelDomain } from '../src'
import { configFor, dryHosting, EXECUTOR, FEE, until } from './fixtures'

/** Each step spends `units` from a reserve, as a stage of a workflow that commits capacity would. */
const spender: Validator = {
  id: 'spender',
  version: 1,
  claims: payload => payload.kind === 'tx' && payload.to === EXECUTOR,
  read: () => ({
    ok: true,
    creates: [],
    exposes: [],
    carries: [],
    retires: [],
    consumes: { units: 1n }
  }),
  confirm: () => true
}

const config = configFor(spender, { native: 8n * FEE, units: 4n })
const journal = {
  sink: { append: async () => undefined, finalize: async () => undefined },
  capacityBytes: 1_000_000
} as const

const step = (tag: string) => ({
  kind: 'tx' as const,
  payload: { kind: 'tx' as const, to: EXECUTOR, data: `0x${tag}`, value: 0n }
})

/** A two-stage workflow resting on what its key desires, on a dry kernel. */
const library = () => {
  const g = createGraph('library')
  const writes = g.occurrences<KeyedWrite<string>>('desire.writes')
  const domain = kernelDomain('library')
  const desire = domain.fact(keyedLevel(g, 'desire', writes))
  const requests = g.node<KernelRequest>('workflow.requests')
  const kernel = declareKernel(g, {
    ...dryHosting(config),
    requests: [requests],
    facts: domain.facts()
  })
  const workflow = declareWorkflow(g, 'workflow', {
    domain,
    state: kernel.nodes.state,
    facts: [desire],
    requests
  })
  const advanced: WorkflowEvent[] = []
  g.effect('workflow.log', {
    requests: { event: every(workflow.events) },
    handle: ({ value }) => void advanced.push(value)
  })
  const runner = createRunner(g.build(), { now: () => 0, journal })
  const state = () => runner.read(kernel.nodes.state)!
  const want = (value: string, expiry = 60_000) => {
    const head = runner.read(kernel.nodes.heads)!
    runner.push(writes, {
      coverage: 'complete',
      entries: { k: value },
      basis: { block: head.number, blockHash: head.hash },
      expiry
    })
  }
  const submit = () => {
    const evidence = factOf(desire, runner.read(desire), 'k')!
    runner.push(kernel.nodes.requests, {
      type: 'Submit',
      plan: act(domain, {
        intentId: 'k#run.0',
        steps: [step('01'), step('02')],
        restsOn: [evidence],
        conflicts: {}
      })
    })
  }
  return { runner, kernel, state, want, submit, advanced }
}

describe('the workflow library', () => {
  it('advances a parked stage once its decision reads the same after its own inclusion', async () => {
    const { runner, kernel, state, want, submit, advanced } = library()
    await kernel.start(runner)
    await until(() => state().lifecycle.kind === 'running', 'running')
    want('T')
    submit()
    await until(() => state().plans['k#run.0']?.phase === 'awaiting-advance', 'the first stage')
    const included = state().plans['k#run.0']!.lastInclusion!
    expect(advanced).toStrictEqual([])
    await until(() => (runner.read(kernel.nodes.heads)?.number ?? 0) >= included, 'the head')
    want('T')
    await until(() => state().plans['k#run.0'] === undefined, 'the second stage')
    expect(advanced).toStrictEqual([{ intentId: 'k#run.0', stage: 1, block: included }])
    expect(state().observations).toStrictEqual({})
    await runner.abandon()
  })

  it('advances again once evidence that expired before its advance is renewed', async () => {
    const { runner, kernel, state, want, submit, advanced } = library()
    await kernel.start(runner)
    await until(() => state().lifecycle.kind === 'running', 'running')
    want('T')
    submit()
    await until(() => state().plans['k#run.0']?.phase === 'awaiting-advance', 'the first stage')
    const included = state().plans['k#run.0']!.lastInclusion!
    await until(() => (runner.read(kernel.nodes.heads)?.number ?? 0) >= included, 'the head')
    const head = runner.read(kernel.nodes.heads)!.number
    want('T', -1)
    await until(() => advanced.length === 1, 'the stalled advance')
    expect(state().plans['k#run.0']?.phase).toBe('awaiting-advance')
    expect(runner.read(kernel.nodes.heads)!.number).toBe(head)
    want('T', 60_000)
    await until(() => state().plans['k#run.0'] === undefined, 'the second stage')
    expect(advanced).toHaveLength(2)
    await runner.abandon()
  })

  it('leaves a stage parked once its decision moved, so publication is never authorized', async () => {
    const { runner, kernel, state, want, submit, advanced } = library()
    await kernel.start(runner)
    await until(() => state().lifecycle.kind === 'running', 'running')
    want('T')
    submit()
    await until(() => state().plans['k#run.0']?.phase === 'awaiting-advance', 'the first stage')
    want('T2')
    await sleep(50)
    expect(advanced).toStrictEqual([])
    expect(state().plans['k#run.0']?.phase).toBe('awaiting-advance')
    expect(state().nonces).not.toHaveProperty('1')
    await runner.abandon()
  })

  it('forgets a fact whose node becomes unavailable, so no advance rests on its last value', () => {
    const g = createGraph('outage')
    const writes = g.occurrences<KeyedWrite<string>>('read.writes')
    const read = keyedLevel(g, 'read', writes)
    const gate = g.level<true>('gate')
    const domain = kernelDomain('outage')
    const desire = domain.fact(
      g.map('desire', { reads: { read: latest(read), gate: latest(gate) }, compute: v => v.read })
    )
    const workflow = declareWorkflow(g, 'workflow', {
      domain,
      state: g.level<KernelState>('kernel.state'),
      facts: [desire],
      requests: g.node<KernelRequest>('requests')
    })
    const runner = createRunner(g.build(), { now: () => 0 })
    const known = () => 'desire' in runner.read(workflow.state)!.facts
    runner.push(gate, { value: true, basis: 0 })
    runner.push(writes, {
      coverage: 'complete',
      entries: { k: 'T' },
      basis: { block: 0, blockHash: '0x0' },
      expiry: 60_000
    })
    expect(known()).toBe(true)
    runner.push(gate, { status: 'failed', reason: 'read' })
    expect(known()).toBe(false)
    runner.push(gate, { value: true, basis: 1 })
    expect(known()).toBe(true)
  })

  it('keeps / in a fact key after its registered node separator', () => {
    expect(factId('desire', 'k/open')).toBe('desire/k/open')
  })
})
