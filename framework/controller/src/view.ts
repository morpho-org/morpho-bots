import type { GraphBuilder, Node } from '@repo/engine'
import type { Id, KernelState } from '@repo/kernel'

import { latest } from '@repo/engine'
import { latched } from '@repo/kernel'

import { parseIntentId } from './intent'

/**
 * The account's complete risk. `busy` names every key the kernel holds risk for: an unresolved send,
 * an executing plan, or an unretired entry, `revoking` and adopted ones included. `numReservations` counts
 * what holds a native reservation: every nonce until its transaction resolves, and every executing
 * plan not yet at one. `acceptingNewWork` is whether the kernel admits new risk at all: running, and
 * not latched on an unresolved send. `conflictMarks` is the kernel's: the block of our own last
 * inclusion or release on each conflict id.
 */
export type KernelView = Readonly<{
  busy: readonly string[]
  numReservations: number
  acceptingNewWork: boolean
  conflictMarks: Readonly<Record<string, number>>
}>

export const isBusy = (view: KernelView | undefined, key: string) =>
  view?.busy.includes(key) === true

export const viewOf = (state: KernelState): KernelView => {
  const busy = new Set<string>()
  /** The kernel's own recovery intents name no key; they count only towards `numReservations`. */
  const hold = (intentId: Id) => {
    const key = parseIntentId(intentId)?.key
    if (key !== undefined) busy.add(key)
  }
  const nonced = new Set<Id>()
  for (const record of Object.values(state.nonces))
    for (const candidate of record.candidates) {
      nonced.add(candidate.intentId)
      if (!record.resolution) hold(candidate.intentId)
    }
  let numReservations = Object.values(state.nonces).filter(record => !record.resolution).length
  for (const plan of Object.values(state.plans)) {
    if (plan.status !== 'executing') continue
    hold(plan.intentId)
    if (!nonced.has(plan.intentId)) numReservations++
  }
  for (const entry of Object.values(state.entries))
    if (entry.state !== 'retired') hold(entry.intentId)
  return {
    busy: [...busy].toSorted(),
    numReservations,
    acceptingNewWork: state.lifecycle.kind === 'running' && !latched(state),
    conflictMarks: state.conflictMarks
  }
}

/** The kernel view as a node, recomputed whenever the kernel's state changes. */
export const declareView = (g: GraphBuilder, id: string, state: Node<KernelState>) =>
  g.map(id, { reads: { state: latest(state) }, compute: ({ state }) => viewOf(state) })
