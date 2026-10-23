import { describe, expect, it } from 'vitest'

import { createGraph, emitTo, every, latest, reachable, sample, watch } from '../src'

describe('reachable', () => {
  it('maps each node a write can lead to onto the node it was reached through', () => {
    const g = createGraph('chain')
    const source = g.occurrences<number>('source')
    const relayed = g.node<number>('relayed')
    const relay = g.fold('relay', {
      reads: { source: every(source) },
      emits: [relayed],
      initial: 0,
      applyInput: (n, { value }) => ({ state: n + value, emit: [emitTo(relayed, value)] })
    })
    g.map('doubled', { reads: { n: latest(relay) }, compute: ({ n }) => n * 2 })
    g.fold('watched', {
      reads: { relayed: watch(relayed) },
      initial: 0,
      applyInput: n => ({ state: n + 1 })
    })
    expect(reachable(g.build(), [source])).toStrictEqual(
      new Map([
        ['source', 'source'],
        ['relay', 'source'],
        ['relayed', 'source'],
        ['doubled', 'relay'],
        ['watched', 'relayed']
      ])
    )
  })

  it('stops at a sample of a node with an initial value, and passes one of a node without', () => {
    const g = createGraph('samples')
    const source = g.occurrences<number>('source')
    const total = g.fold('total', {
      reads: { source: every(source) },
      initial: 0,
      applyInput: (n, { value }) => ({ state: n + value })
    })
    g.map('initialled', { reads: { total: sample(total) }, compute: ({ total }) => total })
    g.map('first', { reads: { source: sample(source) }, compute: ({ source }) => source })
    expect([...reachable(g.build(), [source]).keys()]).toStrictEqual(['source', 'total', 'first'])
  })

  it('reaches a node read along two paths through the first of its reads already reached', () => {
    const g = createGraph('paths')
    const source = g.occurrences<number>('source')
    const near = g.map('near', { reads: { n: latest(source) }, compute: ({ n }) => n })
    const far = g.map('far', { reads: { n: latest(near) }, compute: ({ n }) => n })
    g.map('joined', {
      reads: { far: latest(far), near: latest(near) },
      compute: ({ far, near }) => far + near
    })
    expect(reachable(g.build(), [source]).get('joined')).toBe('far')
  })

  it('starts an effect from its every requests, and from its samples only when it waits on ready', () => {
    const declare = (ready: boolean) => {
      const g = createGraph('effects')
      const source = g.occurrences<number>('source')
      const ticks = g.occurrences<number>('ticks')
      const requested = g.node<number>('requested')
      const sampled = g.node<number>('sampled')
      const gated = g.node<number>('gated')
      g.effect('requests', {
        requests: { source: every(source) },
        results: requested,
        handle: () => {}
      })
      g.effect('samples', {
        requests: { ticks: every(ticks), source: sample(source) as never },
        results: sampled,
        handle: () => {}
      })
      g.effect('gate', {
        requests: { ticks: every(ticks) },
        samples: { source },
        results: gated,
        ...(ready && { ready: () => true }),
        handle: () => {}
      })
      return { graph: g.build(), source }
    }
    const without = declare(false)
    expect([...reachable(without.graph, [without.source]).keys()]).toStrictEqual([
      'source',
      'requested'
    ])
    const withReady = declare(true)
    expect([...reachable(withReady.graph, [withReady.source]).keys()]).toStrictEqual([
      'source',
      'requested',
      'gated'
    ])
  })

  it('carries nothing through the recovery scope when asked to skip it', () => {
    const g = createGraph('recovering')
    const source = g.occurrences<number>('source')
    const inner = g.scope(
      'inner',
      s => s.map('copy', { reads: { n: latest(source) }, compute: ({ n }) => n }),
      { recovery: () => () => undefined }
    )
    g.map('outer', { reads: { n: latest(inner) }, compute: ({ n }) => n })
    const graph = g.build()
    expect([...reachable(graph, [source]).keys()]).toStrictEqual(['source', 'inner.copy', 'outer'])
    expect([...reachable(graph, [source], { skipRecovery: true }).keys()]).toStrictEqual(['source'])
    expect([...reachable(graph, [inner], { skipRecovery: true }).keys()]).toStrictEqual([
      'inner.copy',
      'outer'
    ])
  })
})
