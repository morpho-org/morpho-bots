import type { Keyed, NodeRecord } from '@repo/engine'

import { keyRecord } from '@repo/engine'

import type { Fact, Id, KernelActivity, KernelEvent, Observation } from './types'

import { ABSENT } from './types'

/** The id a fact has in a plan's evidence: a keyed node's id and one of its keys. */
export const factId = (node: string, key: string) => `${node}/${key}`

type Unavailable = 'unknown' | 'failed'

type KeyObservation =
  | Readonly<{ version: string; expiry?: number }>
  | Readonly<{ unavailable: Unavailable }>

/** What observe last delivered for one fact node: per key, its version and expiry, or why none. */
type Watched = Readonly<{
  /** Set while the node itself is not present, so none of its keys can be observed. */
  unavailable?: Unavailable
  absentKnown: boolean
  absentExpiry?: number
  versions: Readonly<Record<string, KeyObservation>>
}>

const keyObservationOf = (keyed: Keyed<unknown>, key: string): KeyObservation => {
  const fact = keyRecord(keyed, key)
  if (fact.status !== 'present' && fact.status !== 'absent') return { unavailable: fact.status }
  const version = fact.status === 'present' ? fact.digest : ABSENT
  return { version, ...(fact.expiry !== undefined && { expiry: fact.expiry }) }
}

/** A keyed fact node as observe sees it, from its current record. */
const watchedOf = (record: NodeRecord<Keyed<unknown>>): Watched => {
  if (record.status !== 'present' || record.value === undefined)
    return {
      unavailable: record.status === 'failed' ? 'failed' : 'unknown',
      absentKnown: false,
      versions: {}
    }
  const keyed = record.value
  return {
    absentKnown: keyed.absentBasis !== undefined,
    ...(keyed.absentExpiry !== undefined && { absentExpiry: keyed.absentExpiry }),
    versions: Object.fromEntries(
      Object.keys(keyed.keys).map(key => [key, keyObservationOf(keyed, key)])
    )
  }
}

/** The observation of one key of `watched`, which may be one it never carried. */
const observedKey = (node: string, watched: Watched, key: string): Observation => {
  const id = factId(node, key)
  if (watched.unavailable) return { id, unavailable: watched.unavailable }
  const observed = watched.versions[key]
  if (observed !== undefined) return { id, ...observed }
  if (!watched.absentKnown) return { id, unavailable: 'unknown' }
  return {
    id,
    version: ABSENT,
    ...(watched.absentExpiry !== undefined && { expiry: watched.absentExpiry })
  }
}

/**
 * The observations that changed from `before` to `after`: every key whose version or expiry moved,
 * every key `after` no longer carries, which is now absent or unknown, and every key in `held` a
 * plan rests on, such as one known absent only under the node's last complete read.
 */
const changedKeys = (
  node: string,
  before: Watched | undefined,
  after: Watched,
  held: readonly string[]
) => {
  const keys = new Set([
    ...Object.keys(before?.versions ?? {}),
    ...Object.keys(after.versions),
    ...held
  ])
  return [...keys].flatMap(key => {
    const next = observedKey(node, after, key)
    const previous = before && observedKey(node, before, key)
    return previous && JSON.stringify(previous) === JSON.stringify(next) ? [] : [next]
  })
}

/** The node a fact id names among `nodes`, and the key within it. */
const locate = (nodes: readonly string[], fact: Fact) => {
  const node = nodes.find(id => fact.id.startsWith(`${id}/`))
  return node === undefined ? undefined : { node, key: fact.id.slice(node.length + 1) }
}

/** The facts a submission or an advance rests on. */
const evidenceOf = (request: KernelEvent): readonly Fact[] =>
  request.type === 'Submit'
    ? (request.plan.evidence ?? [])
    : request.type === 'Advance'
      ? (request.evidence ?? [])
      : []

/** A request on its way to the kernel, with the current observation of every fact it names. */
const seeded = (request: KernelEvent, watched: Readonly<Record<string, Watched>>): KernelEvent => {
  if (request.type !== 'Submit' && request.type !== 'Advance') return request
  const observations = evidenceOf(request).flatMap(fact => {
    const found = locate(Object.keys(watched), fact)
    return found ? [observedKey(found.node, watched[found.node]!, found.key)] : []
  })
  return { ...request, observations }
}

/** The first notice a submission gets: admitted, or not admitted at all. */
const ANSWERS = new Set(['admitted', 'refused', 'known'])
/** Notices that end an admitted plan, after which nothing rests on its facts. */
const ENDED = new Set(['abandoned', 'settled', 'compensating', 'compensated', 'failed'])

/**
 * One submission's facts, held from the Submit until its plan ends or it is not admitted. Every
 * submission has one, with or without facts, so each answer is matched to the submission it answers.
 */
type Subscription = Readonly<{ intentId: Id; facts: readonly Id[]; admitted: boolean }>

/**
 * What observe holds: each fact node as it last delivered it, and each submission whose facts it
 * keeps delivering, so a change to a fact no read carries still reaches the kernel while a plan rests
 * on it. A duplicate submission's refusal ends only its own subscription, not the live plan's.
 */
type Observing = Readonly<{
  watched: Readonly<Record<string, Watched>>
  subscriptions: readonly Subscription[]
}>

export const OBSERVING: Observing = { watched: {}, subscriptions: [] }

/**
 * A request forwarded with its seeds, its facts subscribed until its plan ends. An advance adds its
 * stage's facts to its admitted plan's subscription, so whether it is admitted or stalled, every
 * fact the plan may rest on keeps reaching the kernel.
 */
export const observeRequest = (state: Observing, request: KernelEvent) => {
  const facts = evidenceOf(request).map(fact => fact.id)
  const subscriptions =
    request.type === 'Submit'
      ? [...state.subscriptions, { intentId: request.plan.intentId, facts, admitted: false }]
      : request.type === 'Advance'
        ? state.subscriptions.map(sub =>
            sub.intentId === request.intentId && sub.admitted
              ? { ...sub, facts: [...new Set([...sub.facts, ...facts])] }
              : sub
          )
        : state.subscriptions
  return { state: { ...state, subscriptions }, request: seeded(request, state.watched) }
}

/** Notices answer submissions in the order they were made, and end admitted plans. */
export const observeActivity = (state: Observing, activity: readonly KernelActivity[]) => {
  let subscriptions = [...state.subscriptions]
  for (const a of activity) {
    if (a.type !== 'notice') continue
    const answered = ANSWERS.has(a.notice)
    if (!answered && !ENDED.has(a.notice)) continue
    const at = subscriptions.findIndex(
      sub => sub.intentId === a.intentId && sub.admitted === !answered
    )
    if (at < 0) continue
    const sub = subscriptions[at]!
    subscriptions =
      a.notice === 'admitted'
        ? subscriptions.with(at, { ...sub, admitted: true })
        : subscriptions.toSpliced(at, 1)
  }
  return { ...state, subscriptions }
}

/** A fact node's new record: the observations that changed, for the kernel. */
export const observeNode = (
  state: Observing,
  node: string,
  record: NodeRecord<Keyed<unknown>>
): { state: Observing; changes: Observation[] } => {
  const after = watchedOf(record)
  const prefix = `${node}/`
  const held = state.subscriptions.flatMap(sub =>
    sub.facts.flatMap(id => (id.startsWith(prefix) ? [id.slice(prefix.length)] : []))
  )
  const changes = changedKeys(node, state.watched[node], after, held)
  return { state: { ...state, watched: { ...state.watched, [node]: after } }, changes }
}
