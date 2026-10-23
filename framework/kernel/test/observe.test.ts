import type { Keyed, KeyedWrite, NodeRecord } from '@repo/engine'

import { createGraph, createRunner, keyedLevel } from '@repo/engine'
import { describe, expect, it } from 'vitest'

import type { KernelEvent, Observation } from '../src'

import { observeActivity, observeNode, observeRequest, OBSERVING } from '../src/observe'
import { ABSENT } from '../src/types'
import { liquidationPlan } from './fixtures'

const NODE = 'positions'
const BASIS = { block: 1, blockHash: '0x1a' }

const record = (keyed: Keyed<unknown>): NodeRecord<Keyed<unknown>> => ({
  status: 'present',
  value: keyed
})

/** A keyed level fed through the engine, never started, so no expiry wakes it. */
const level = () => {
  const g = createGraph('observe')
  const writes = g.occurrences<KeyedWrite<unknown>>(`${NODE}.writes`)
  const node = keyedLevel(g, NODE, writes)
  const runner = createRunner(g.build())
  return (change: KeyedWrite<unknown>) => {
    runner.push(writes, change)
    return runner.read(node)!
  }
}

/** Observe after a plan resting on `keys` was submitted and admitted, so it keeps hearing them. */
const subscribed = (keys: readonly string[], keyed: Keyed<unknown>) => {
  const seeded = observeNode(OBSERVING, NODE, record(keyed)).state
  const submit: KernelEvent = {
    type: 'Submit',
    plan: liquidationPlan('liq', {
      evidence: keys.map(key => ({ id: `${NODE}/${key}`, version: ABSENT, basis: BASIS }))
    })
  }
  const { state, request } = observeRequest(seeded, submit)
  const admitted = observeActivity(state, [{ type: 'notice', intentId: 'liq', notice: 'admitted' }])
  return { state: admitted, request }
}

const seeds = (request: KernelEvent) =>
  request.type === 'Submit' ? (request.observations ?? []) : []

describe('the observations a fact node yields', () => {
  it('reports a key whose expiry moved though its version did not', () => {
    const write = level()
    const first = write({ coverage: 'complete', entries: { a: 1 }, basis: BASIS })
    const second = write({
      coverage: 'complete',
      entries: { a: 1 },
      basis: BASIS,
      expiry: 9
    })
    const { state } = observeNode(OBSERVING, NODE, record(first))
    const { changes } = observeNode(state, NODE, record(second))
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ id: `${NODE}/a`, expiry: 9 })
  })

  it('carries the expiry of a key read as gone', () => {
    const keyed = level()({
      coverage: 'carried',
      entries: {},
      absent: ['a'],
      basis: BASIS,
      expiry: 7
    })
    const { changes } = observeNode(OBSERVING, NODE, record(keyed))
    expect(changes).toStrictEqual([{ id: `${NODE}/a`, version: ABSENT, expiry: 7 }])
  })

  it('seeds a submission with the expiry of an absence only a complete read implies', () => {
    const keyed = level()({
      coverage: 'complete',
      entries: {},
      basis: BASIS,
      expiry: 100,
      empty: true
    })
    const { request } = subscribed(['never'], keyed)
    expect(seeds(request)).toStrictEqual<Observation[]>([
      { id: `${NODE}/never`, version: ABSENT, expiry: 100 }
    ])
  })

  it('tells a subscribed key it never carried when its implied absence moves, gains or loses an expiry', () => {
    const empty = { coverage: 'complete', entries: {}, basis: BASIS, empty: true } as const
    const write = level()
    const { state } = subscribed(['never'], write(empty))
    const id = `${NODE}/never`
    const gained = observeNode(state, NODE, record(write({ ...empty, expiry: 100 })))
    expect(gained.changes).toStrictEqual([{ id, version: ABSENT, expiry: 100 }])
    const moved = observeNode(gained.state, NODE, record(write({ ...empty, expiry: 40 })))
    expect(moved.changes).toStrictEqual([{ id, version: ABSENT, expiry: 40 }])
    const lost = observeNode(moved.state, NODE, record(write(empty)))
    expect(lost.changes).toStrictEqual([{ id, version: ABSENT }])
  })

  it('reports every key unavailable while the node itself failed, as a failed whole-node input leaves it', () => {
    const keyed = level()({
      coverage: 'complete',
      entries: { a: 1 },
      basis: BASIS,
      expiry: 9
    })
    const { state } = observeNode(OBSERVING, NODE, record(keyed))
    const { changes } = observeNode(state, NODE, { status: 'failed' })
    expect(changes).toStrictEqual([{ id: `${NODE}/a`, unavailable: 'failed' }])
  })
})
