import type { KernelRequest } from '@repo/kernel'

import { createGraph, createRunner, every } from '@repo/engine'
import { describe, expect, it } from 'vitest'

import { declareHaltPolicy } from '../src'

const haltPolicy = () => {
  const g = createGraph('halt-policy')
  const outcomes = g.occurrences<'ok' | 'failed'>('outcomes')
  const requests = g.node<KernelRequest>('monitor.requests')
  declareHaltPolicy(g, 'monitor', {
    over: outcomes,
    requests,
    initial: 0,
    applyInput: (failures, outcome) => {
      const next = outcome === 'failed' ? failures + 1 : 0
      return { state: next, ...(next >= 2 && { halt: 'two failures' }) }
    }
  })
  const sent = g.fold('sent', {
    reads: { request: every(requests) },
    initial: [] as KernelRequest[],
    applyInput: (seen, { value }) => ({ state: [...seen, value] })
  })
  const runner = createRunner(g.build())
  return { runner, outcomes, sent: () => runner.read(sent) }
}

describe('declareHaltPolicy', () => {
  it('requests a halt once its policy calls for it, and only once', () => {
    const { runner, outcomes, sent } = haltPolicy()
    runner.push(outcomes, 'failed')
    expect(sent()).toStrictEqual([])
    runner.push(outcomes, 'failed')
    runner.push(outcomes, 'failed')
    expect(sent()).toStrictEqual([{ type: 'Halt', reason: 'two failures' }])
  })
})
