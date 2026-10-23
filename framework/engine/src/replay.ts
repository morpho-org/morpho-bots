import type { Graph } from './graph'
import type { JournalEntry } from './journal'

import { createCore, layout } from './core'
import { encode } from './data'
import { expandJournalWrite } from './journal'

export type ReplayReport =
  | Readonly<{ ok: true; steps: number }>
  | Readonly<{ ok: false; step: number; reason: string }>

/**
 * Re-runs each journaled step's stamped writes and wakes on a fresh copy of `graph` and reports the first step
 * whose derived writes differ, counting steps only. No effect runs: their results are among the
 * journaled writes, and their notes are skipped. After a journaled recovery, only the graph's
 * recovery is evaluated, as it was when the run degraded.
 */
export const replay = (graph: Graph, entries: readonly JournalEntry[]): ReplayReport => {
  const core = createCore(graph)
  const previous: Parameters<typeof expandJournalWrite>[1] = new Map()
  const pendingOf = ({ node, value }: { node: string; value: unknown }) => {
    const kind = graph[layout].nodes.get(node)?.kind
    return kind === 'level' || kind === 'occurrence'
      ? core.accept(node, value)
      : core.produced(node, value)
  }
  let index = 0
  for (const entry of entries) {
    if (entry.kind === 'recovery')
      core.keepOnly(new Set(graph[layout].recoveries.flatMap(r => r.members)))
    if (entry.kind !== 'step') continue
    index += 1
    let derived: unknown
    try {
      const writes = entry.writes.map(write => expandJournalWrite(write, previous))
      if (writes.some(write => write === undefined))
        return { ok: false, step: index, reason: 'a keyed delta has no earlier complete write' }
      derived = core.run(
        writes.map(write => pendingOf(write!)),
        entry.stamp,
        entry.wakes
      )
      for (const effect of graph[layout].effects)
        core.take(`effect:${effect.id}`, Object.keys(effect.reads))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, step: index, reason: `the step threw: ${reason}` }
    }
    if (encode(derived) !== encode(entry.derived))
      return { ok: false, step: index, reason: 'derived writes differ' }
  }
  return { ok: true, steps: index }
}
