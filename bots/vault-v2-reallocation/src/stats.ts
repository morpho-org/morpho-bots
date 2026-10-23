import type { KeyedWrite } from '@repo/engine'
import type { KernelActivity, KernelHead } from '@repo/kernel'

import { INTENT_END_NOTICES } from '@repo/kit'

import type { VaultReading } from './reallocation'

/** What `tick.end` counts since the previous read, by the names the dashboards chart. */
export type TickCounts = Readonly<{
  sim_reverts: number
  dry_runs: number
  broadcast: number
  errors: number
}>

/** One read as `tick.end` reports it: the source's write, its block, and the counts before it. */
export type Tick = Readonly<{ write: KeyedWrite<VaultReading>; block: number; counts: TickCounts }>

export type TickState = Readonly<{
  counts: TickCounts
  /** The newest kernel head, the block of a read that failed and so names none. */
  head: number
  /** The nonces each live intent has broadcast at, so a replacement is not counted again. */
  sent: Readonly<Record<string, readonly number[]>>
}>

export type TickInput =
  | Readonly<{ from: 'prepared'; value: Readonly<{ ok: boolean; reason?: string }> }>
  | Readonly<{ from: 'activity'; value: readonly KernelActivity[] }>
  | Readonly<{ from: 'head'; value: KernelHead }>
  | Readonly<{ from: 'world'; value: KeyedWrite<VaultReading> }>

const NONE: TickCounts = { sim_reverts: 0, dry_runs: 0, broadcast: 0, errors: 0 }

export const NO_TICK: TickState = { counts: NONE, head: 0, sent: {} }

/** The preparation reasons `tick.end` counts, by the counter each adds to. */
const PREPARED: Readonly<Record<string, keyof TickCounts>> = {
  reverted: 'sim_reverts',
  dry_run: 'dry_runs',
  error: 'errors'
}

const add = (counts: TickCounts, name: keyof TickCounts) => ({
  ...counts,
  [name]: counts[name] + 1
})

const afterActivity = (state: TickState, activity: readonly KernelActivity[]): TickState => {
  let { counts } = state
  const sent = { ...state.sent }
  for (const a of activity) {
    if (a.type === 'notice' && INTENT_END_NOTICES.has(a.notice)) delete sent[a.intentId]
    if (a.type !== 'sent' || a.kind !== 'step') continue
    if (a.status === 'rejected' || a.status === 'withheld') continue
    const nonces = sent[a.intentId] ?? []
    if (nonces.includes(a.nonce)) continue
    sent[a.intentId] = [...nonces, a.nonce]
    counts = add(counts, 'broadcast')
  }
  return { ...state, counts, sent }
}

const blockOf = (write: KeyedWrite<VaultReading>, head: number) =>
  'basis' in write ? (write.basis as Readonly<{ block: number }>).block : head

/** Folds one input of the `ticks` fold; a read emits its {@link Tick} and starts the next count. */
export const countTick = (
  state: TickState,
  input: TickInput
): Readonly<{ state: TickState; tick?: Tick }> => {
  if (input.from === 'prepared') {
    const counter = input.value.ok ? undefined : PREPARED[input.value.reason ?? '']
    return { state: counter ? { ...state, counts: add(state.counts, counter) } : state }
  }
  if (input.from === 'activity') return { state: afterActivity(state, input.value) }
  if (input.from === 'head') return { state: { ...state, head: input.value.number } }
  return {
    state: { ...state, counts: NONE },
    tick: { write: input.value, block: blockOf(input.value, state.head), counts: state.counts }
  }
}
