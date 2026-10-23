import type { EffectOperator, Graph, Node, OperatorSpec } from './graph'

import { layout } from './core'

/** Every edge schedules its reader but a `sample` of a node with an initial value. */
const schedulesFrom = (graph: Graph, reads: OperatorSpec['reads']) =>
  Object.values(reads).flatMap(edge =>
    edge.mode !== 'latest' || edge.trigger || !graph[layout].initials.has(edge.node.id)
      ? [edge.node.id]
      : []
  )

/**
 * Only `every` requests buffer deliveries; a waiting request's `ready` is re-checked against every
 * sample, since which of them it reads is not visible.
 */
const startsFrom = (effect: EffectOperator) => [
  ...Object.values(effect.reads).flatMap(edge => (edge.mode === 'every' ? [edge.node.id] : [])),
  ...(effect.spec.ready === undefined ? [] : Object.values(effect.samples))
]

/**
 * Every node a write to `from` may lead the runner to write, over declared edges, emits and results,
 * mapped to the node it was reached through; each of `from` maps to itself. Clocks and expiries are
 * not seeded. With `skipRecovery`, the recovery scope's operators and effects carry nothing further.
 */
export const reachable = (
  graph: Graph,
  from: readonly Node<unknown>[],
  options: Readonly<{ skipRecovery?: boolean }> = {}
): ReadonlyMap<string, string> => {
  const { operators, effects, recoveries } = graph[layout]
  const skipped = new Set(
    options.skipRecovery ? recoveries.flatMap(recovery => recovery.members) : []
  )
  const steps = [
    ...operators.map(op => ({
      id: op.id,
      from: schedulesFrom(graph, op.reads),
      to: op.kind === 'fold' ? [op.output, ...op.emits] : [op.output]
    })),
    ...effects.map(effect => ({
      id: effect.id,
      from: startsFrom(effect),
      to: effect.results === undefined ? [] : [effect.results]
    }))
  ].filter(step => !skipped.has(step.id))
  const via = new Map(from.map(node => [node.id, node.id]))
  for (let grew = true; grew; ) {
    grew = false
    for (const step of steps) {
      const hit = step.from.find(node => via.has(node))
      if (hit === undefined) continue
      const reached = step.to.filter(node => !via.has(node))
      for (const node of reached) via.set(node, hit)
      grew ||= reached.length > 0
    }
  }
  return via
}
