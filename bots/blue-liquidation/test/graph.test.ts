import type { Graph } from '@repo/engine'
import type { Logger } from '@repo/kit'

import { layoutOf } from '@repo/engine/testing'
import { FakeChain, MemoryStore } from '@repo/kernel/testing'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { declareLiquidator } from '../src/graph'
import { createTickStats } from '../src/stats'
import { EXECUTOR, kernelConfig } from './scenario/bot'

const unused = () => {
  throw new Error('declaring the graph runs nothing')
}

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never

const declared = () => {
  const chain = new FakeChain()
  return declareLiquidator({
    kernel: {
      config: kernelConfig(4),
      store: new MemoryStore(),
      chain,
      effects: chain.effects,
      enrollment: 'enrolled',
      pollMs: 5,
      effectTimeoutMs: 1_000,
      reorgDepth: 16,
      onError: () => {}
    },
    world: { discover: unused, readLens: unused },
    worldValidMs: 60_000,
    quotes: { quoteFor: unused, validForMs: 60_000, retryMs: 1_000 },
    prepare: { executor: EXECUTOR, encode: unused, simulate: unused },
    venue: { concurrency: 4, budget: { calls: 2, perMs: 1_000 } },
    simulations: 4,
    backoff: { baseBlocks: 1, maxBlocks: 4 },
    runId: 'run',
    maxReservations: 4,
    stats: createTickStats(),
    logger: silent
  }).graph
}

/**
 * Everything about a built graph an operator or a replay can see: nodes by id, since their
 * declaration order is not observable; operators in evaluation order; effects in dispatch order.
 */
const structureOf = (built: Graph) => {
  const graph = layoutOf(built)
  return {
    id: built.id,
    nodes: [...graph.nodes.values()]
      .map(({ id, kind, coalesces, clock }) => ({
        id,
        kind,
        coalesces,
        ...(clock && { everyMs: clock.everyMs })
      }))
      .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    operators: graph.operators.map(op => ({
      kind: op.kind,
      id: op.id,
      output: op.output,
      ...(op.kind === 'fold' && { emits: op.emits, afterInputs: op.afterInputs !== undefined }),
      reads: Object.entries(op.reads).map(([name, edge]) => ({
        name,
        mode: edge.mode,
        node: edge.node.id,
        ...('trigger' in edge && { trigger: edge.trigger })
      }))
    })),
    effects: graph.effects.map(effect => ({
      id: effect.id,
      reads: Object.entries(effect.reads).map(([name, edge]) => ({ name, node: edge.node.id })),
      samples: Object.values(effect.samples).toSorted(),
      results: effect.results,
      lane: effect.lane
    })),
    recovery: graph.recoveries.flatMap(recovery => recovery.members).toSorted()
  }
}

const EXPECTED = JSON.parse(
  readFileSync(new URL('./graph.structure.json', import.meta.url), 'utf8')
) as unknown

describe('the liquidator graph', () => {
  it('keeps every node id, edge, lane and recovery member operators and dashboards rely on', () => {
    expect(JSON.parse(JSON.stringify(structureOf(declared())))).toStrictEqual(EXPECTED)
  })
})
