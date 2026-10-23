import type { Data } from './data'
import type { GraphBuilder, Latest, MapInputs, Node, Stream } from './graph'

import { digestOf } from './core'
import { GraphDefinitionError, WriteRefusedError } from './errors'
import { every, latest } from './graph'

/**
 * One key's current value: present or known absent, with its read point `B` and expiry, or
 * unknown.
 */
export type KeyRecord<T, B extends Data = Data> =
  | Readonly<{ status: 'present'; value: T; digest: string; basis: B; expiry?: number }>
  | Readonly<{ status: 'absent'; basis: B; expiry?: number }>
  | Readonly<{ status: 'unknown' | 'failed'; reason?: string }>

/**
 * A level over an open set of keys. A key missing from `keys` is known absent under `absentBasis`
 * until `absentExpiry`, both from the last write that vouched for the whole scope, and unknown
 * before one; `coverage` says whether the latest read of the scope succeeded, without changing any
 * key it did not carry.
 */
export type Keyed<T, B extends Data = Data> = Readonly<{
  coverage: Readonly<{ status: 'complete' | 'unknown' | 'failed'; reason?: string }>
  absentBasis?: B
  absentExpiry?: number
  keys: Readonly<Record<string, KeyRecord<T, B>>>
}>

/**
 * What a keyed source writes: the complete scope, whose empty form must be asserted with `empty`;
 * only the keys it carries, present in `entries`, read as gone in `absent`, or whose own read failed
 * in `failed`; or that a read failed, for the scope or for `keys` alone.
 */
export type KeyedWrite<T, B extends Data = Data> =
  | Readonly<{
      coverage: 'complete'
      entries: Readonly<Record<string, T>>
      basis: B
      expiry?: number
      empty?: true
    }>
  | Readonly<{
      coverage: 'carried'
      entries: Readonly<Record<string, T>>
      absent?: readonly string[]
      failed?: readonly string[]
      basis: B
      expiry?: number
    }>
  | Readonly<{ coverage: 'unknown' | 'failed'; keys?: readonly string[]; reason?: string }>

export const UNREAD: Keyed<never, never> = { coverage: { status: 'unknown' }, keys: {} }

const present = <T, B extends Data>(value: T, basis: B, expiry?: number): KeyRecord<T, B> => ({
  status: 'present',
  value,
  digest: digestOf(value),
  basis,
  ...(expiry !== undefined && { expiry })
})

const absent = <B extends Data>(basis: B, expiry?: number): KeyRecord<never, B> => ({
  status: 'absent',
  basis,
  ...(expiry !== undefined && { expiry })
})

const earlier = (left?: number, right?: number) =>
  left === undefined ? right : right === undefined ? left : Math.min(left, right)

/** Every expiry a keyed value carries: each key's own, and the absence the last complete write vouched for. */
const expiriesOf = (keyed: Keyed<unknown>) => [
  ...(keyed.absentExpiry === undefined ? [] : [keyed.absentExpiry]),
  ...Object.values(keyed.keys).flatMap(fact =>
    'expiry' in fact && fact.expiry !== undefined ? [fact.expiry] : []
  )
]

/** The state of `key`: its own fact, else absent under the last complete write, else unknown. */
export const keyRecord = <T, B extends Data>(keyed: Keyed<T, B>, key: string): KeyRecord<T, B> =>
  (Object.hasOwn(keyed.keys, key) ? keyed.keys[key] : undefined) ??
  (keyed.absentBasis === undefined
    ? { status: 'unknown' }
    : absent(keyed.absentBasis, keyed.absentExpiry))

/** Applies one write; a failed read changes no key it does not name, so nothing becomes absent. */
const applyKeyed = <T, B extends Data>(
  node: string,
  keyed: Keyed<T, B>,
  write: KeyedWrite<T, B>
): Keyed<T, B> => {
  if (write.coverage !== 'complete' && write.coverage !== 'carried') {
    const fact = {
      status: write.coverage,
      ...(write.reason !== undefined && { reason: write.reason })
    } as const
    if (write.keys === undefined) return { ...keyed, coverage: fact }
    const failed = Object.fromEntries(write.keys.map(key => [key, fact]))
    return { ...keyed, keys: { ...keyed.keys, ...failed } }
  }
  const entries = Object.entries(write.entries)
  const carried: Record<string, KeyRecord<T, B>> = Object.fromEntries(
    entries.map(([key, value]) => [key, present(value, write.basis, write.expiry)])
  )
  if (write.coverage === 'carried') {
    const gone = (write.absent ?? []).map(key => [key, absent(write.basis, write.expiry)])
    const failed = (write.failed ?? []).map(key => [key, { status: 'failed' }])
    return {
      ...keyed,
      keys: {
        ...keyed.keys,
        ...Object.fromEntries(failed),
        ...Object.fromEntries(gone),
        ...carried
      }
    }
  }
  if (entries.length === 0 && write.empty !== true)
    throw new WriteRefusedError(node, 'an empty complete level is asserted with `empty`')
  return {
    coverage: { status: 'complete' },
    absentBasis: write.basis,
    ...(write.expiry !== undefined && { absentExpiry: write.expiry }),
    keys: carried
  }
}

/**
 * A keyed level over the writes a source adapter makes to `writes`, applied in delivery order.
 * @throws WriteRefusedError - in the step, stopping the runner, for an unasserted empty level.
 */
export const keyedLevel = <T, B extends Data = Data>(
  g: GraphBuilder,
  id: string,
  writes: Stream<KeyedWrite<T, B>>
) =>
  g.fold(
    id,
    {
      reads: { write: every(writes) },
      initial: UNREAD as Keyed<T, B>,
      applyInput: (keyed, { value }) => ({ state: applyKeyed(id, keyed, value) })
    },
    { expiries: expiriesOf }
  )

type WithInputs = Record<string, Latest<unknown>>

/** The name of `keyedMap`'s own read of `over`, which no `with` input may take. */
const OVER = 'over'

/** The read a projected key came from: its basis and its expiry, both kept by the projection. */
export type KeyRead<B extends Data = Data> = Readonly<{ basis: B; expiry?: number }>

export type KeyedMapOptions<I, W extends WithInputs> = Readonly<{
  /** Whole nodes `project` reads beside each key: `latest` by default, `sample` to not trigger. */
  with?: W
  /**
   * A deadline for a projected key, which only ever shortens the one it was read under. A key
   * projected absent is not passed to it, and keeps the expiry of the read it came from.
   */
  expiry?: (value: I, key: string, inputs: MapInputs<W>) => number | undefined
}>

/**
 * Projects each present key; `undefined` makes the key known absent under the read it came from,
 * until that read's expiry. Coverage, basis and the absence of keys the input does not carry pass
 * through from `over` alone, so a `with` input must never be what makes an act safe at a chain read
 * point or for freshness (`docs/framework/AUTHORING.md` §3).
 * @throws GraphDefinitionError - when a `with` input is named `over`.
 * @throws WriteRefusedError - in the step, stopping the runner, for an `expiry` that is not a
 * non-negative safe integer.
 */
export const keyedMap = <I, O, W extends WithInputs = Record<never, never>, B extends Data = Data>(
  g: GraphBuilder,
  id: string,
  over: Node<Keyed<I, B>>,
  project: (value: I, key: string, inputs: MapInputs<W>, read: KeyRead<B>) => O | undefined,
  options: KeyedMapOptions<I, W> = {}
) => {
  const extra: WithInputs = options.with ?? {}
  if (OVER in extra) throw new GraphDefinitionError(`${id} reads a with input named ${OVER}`)
  return g.map(
    id,
    {
      reads: { ...extra, [OVER]: latest(over) },
      compute: ({ [OVER]: keyed, ...rest }): Keyed<O, B> => {
        const inputs = rest as MapInputs<W>
        return {
          ...keyed,
          keys: Object.fromEntries(
            Object.entries(keyed.keys).map(([key, fact]): [string, KeyRecord<O, B>] => {
              if (fact.status !== 'present') return [key, fact]
              const read = {
                basis: fact.basis,
                ...(fact.expiry !== undefined && { expiry: fact.expiry })
              }
              const value = project(fact.value, key, inputs, read)
              if (value === undefined) return [key, absent(fact.basis, fact.expiry)]
              const shortened = options.expiry?.(fact.value, key, inputs)
              if (shortened !== undefined && !(Number.isSafeInteger(shortened) && shortened >= 0))
                throw new WriteRefusedError(id, 'an expiry is not a non-negative safe integer')
              return [key, present(value, fact.basis, earlier(fact.expiry, shortened))]
            })
          )
        }
      }
    },
    { expiries: expiriesOf }
  )
}
