import { createHash } from 'node:crypto'

import type { Data } from './data'
import type { Delivery, Graph, Node, NodeSpec, OperatorSpec, Stamp } from './graph'

import { encode, freezeData } from './data'
import { CycleBoundError, GraphDefinitionError, WriteRefusedError } from './errors'

/** How many times one step may re-enter any one operator it already evaluated before it fails. */
const CYCLE_BOUND = 64

type Status = 'present' | 'unknown' | 'failed'

/**
 * A node's current write. `basis`, `expiry` and `reason` are refreshed by every write and are
 * visible to readers even when equal. A node never written is `unwritten`, carrying its build-time
 * initial value when it has one.
 */
export type NodeRecord<T> = Readonly<{
  status: Status | 'unwritten'
  value?: T
  digest?: string
  basis?: Data
  expiry?: number
  reason?: string
}>

type Written = Omit<NodeRecord<unknown>, 'status'> & { status: Status }

/** A validated write, kept in the form it was pushed so replay can push it again. */
export type Pending = Readonly<{ node: string; pushed: unknown; written: Written }>

export type DerivedWrite = Readonly<{ node: string; digest: string }>

type Sequenced = Delivery<unknown> & { seq: number }

/** The digest of a value's canonical encoding: what decides whether a write changed its node. */
export const digestOf = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex')

const metaOf = (record: NodeRecord<unknown>) =>
  encode({ basis: record.basis, expiry: record.expiry, reason: record.reason })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const MALFORMED_EXPIRY = 'an expiry is not a safe integer'

const levelWrite = (node: string, pushed: unknown): Written => {
  if (!isRecord(pushed)) throw new WriteRefusedError(node, 'a level write is a record')
  if (pushed.expiry !== undefined && !Number.isSafeInteger(pushed.expiry))
    throw new WriteRefusedError(node, MALFORMED_EXPIRY)
  if (pushed.status === 'unknown' || pushed.status === 'failed')
    return {
      status: pushed.status,
      ...(typeof pushed.reason === 'string' && { reason: pushed.reason })
    }
  if (!('value' in pushed) || pushed.basis === undefined)
    throw new WriteRefusedError(node, 'a level write carries its value and its basis')
  encode(pushed.basis)
  return {
    status: 'present',
    value: pushed.value,
    basis: pushed.basis as Data,
    ...(pushed.expiry !== undefined && { expiry: pushed.expiry as number })
  }
}

/** The key of a built {@link Graph}'s layout, which only the engine holds. */
export const layout: unique symbol = Symbol('layout')

/** Whether a record holds a value: a present write, or the initial value of a node not yet written. */
const readable = (record: NodeRecord<unknown>) =>
  record.status === 'present' || (record.status === 'unwritten' && record.digest !== undefined)

/**
 * The value each node holds before its first write: every fold's initial value, and each map's
 * output over inputs that all have one, in evaluation order, frozen.
 * @throws GraphDefinitionError - naming a map that throws, or computes something not data, on them.
 */
export const initialValues = (operators: readonly OperatorSpec[]) => {
  const initials = new Map<string, unknown>()
  for (const op of operators)
    if (op.kind === 'fold') initials.set(op.output, freezeData(op.initial))
  for (const op of operators) {
    if (op.kind !== 'map') continue
    const edges = Object.entries(op.reads)
    if (!edges.every(([, edge]) => edge.mode === 'latest' && initials.has(edge.node.id))) continue
    const inputs = Object.fromEntries(
      edges.map(([name, edge]) => [name, initials.get(edge.node.id)])
    )
    try {
      const value = freezeData(op.compute(inputs))
      initials.set(op.output, value)
    } catch (cause) {
      throw new GraphDefinitionError(`map ${op.id} fails on its initial inputs`, { cause })
    }
  }
  return initials
}

/**
 * A level's own expiry, or what its producer's `expiries` finds in a present value, ascending.
 * @throws WriteRefusedError - for an expiry that is not a safe integer.
 */
const expiriesOf = (spec: NodeSpec, written: Written, value: unknown): readonly number[] => {
  const found =
    spec.kind === 'level'
      ? written.expiry === undefined
        ? []
        : [written.expiry]
      : written.status === 'present' && spec.expiries
        ? [...spec.expiries(value)]
        : []
  if (!found.every(expiry => Number.isSafeInteger(expiry)))
    throw new WriteRefusedError(spec.id, MALFORMED_EXPIRY)
  return [...new Set(found)].toSorted((left, right) => left - right)
}

const readerKey = (reader: string, input: string) => `${reader}\u0000${input}`

/** Operators and effects read through disjoint keys, whatever ids they were declared with. */
const operatorReader = (id: string) => `op:${id}`

/**
 * The graph's nodes and one step of propagation. A step applies its writes and evaluates every
 * operator they schedule, in evaluation order, until none is scheduled; it commits all of it or,
 * when anything throws, none of it.
 */
export const createCore = (graph: Graph) => {
  const records = new Map<string, NodeRecord<unknown>>()
  const buffers = new Map<string, Sequenced[]>()
  const readers = new Map<
    string,
    { operator?: OperatorSpec; key: string; mode: 'latest' | 'every' | 'watch'; trigger: boolean }[]
  >()
  /** The sequence of each node's last recorded write, and of the last one each watcher was handed. */
  const lastWrite = new Map<string, number>()
  const watched = new Map<string, number>()
  /** Each node's expiries its watchers have not seen pass, ascending: each wakes them. */
  const expiries = new Map<string, readonly number[]>()
  let writeSeq = 0
  /** Once set, only these operators are evaluated; the rest keep their last value. */
  let kept: ReadonlySet<string> | undefined
  let failedOperator: string | undefined

  for (const spec of graph[layout].nodes.values())
    records.set(spec.id, Object.freeze({ status: 'unwritten' }))
  for (const [node, initial] of graph[layout].initials) {
    records.set(
      node,
      Object.freeze({ status: 'unwritten', value: initial, digest: digestOf(initial) })
    )
    expiries.set(node, expiriesOf(graph[layout].nodes.get(node)!, { status: 'present' }, initial))
  }
  const addReader = (reader: string, reads: OperatorSpec['reads'], operator?: OperatorSpec) => {
    for (const [input, edge] of Object.entries(reads)) {
      const list = readers.get(edge.node.id) ?? []
      const trigger = edge.mode !== 'latest' || edge.trigger
      list.push({
        ...(operator && { operator }),
        key: readerKey(reader, input),
        mode: edge.mode,
        trigger
      })
      readers.set(edge.node.id, list)
      if (edge.mode === 'every') buffers.set(readerKey(reader, input), [])
    }
  }
  for (const op of graph[layout].operators) addReader(operatorReader(op.id), op.reads, op)
  for (const effect of graph[layout].effects) addReader(`effect:${effect.id}`, effect.reads)
  /** Only a watcher sees time pass without a write, so only a watched node's expiries wake anything. */
  const isWatched = (node: string) =>
    (readers.get(node) ?? []).some(
      reader =>
        reader.mode === 'watch' && reader.operator && (!kept || kept.has(reader.operator.id))
    )

  let step:
    | {
        stamp: Stamp
        dirty: Set<OperatorSpec>
        reentries: Map<OperatorSpec, number>
        derived: DerivedWrite[]
      }
    | undefined

  const schedule = (operator: OperatorSpec) => {
    if (!step || step.dirty.has(operator) || (kept && !kept.has(operator.id))) return
    const entries = step.reentries.get(operator)
    if (entries !== undefined && entries + 1 > CYCLE_BOUND)
      throw new CycleBoundError(CYCLE_BOUND, operator.id)
    if (entries !== undefined) step.reentries.set(operator, entries + 1)
    step.dirty.add(operator)
  }

  /** Forgets the expiries of `node` its watchers now see as passed, at the step's time. */
  const presented = (node: string, list: readonly number[]) => {
    const pending = list.filter(expiry => expiry > step!.stamp.at)
    if (pending.length > 0) expiries.set(node, pending)
    else expiries.delete(node)
  }

  const write = (node: string, written: Written, derived: boolean) => {
    const spec = graph[layout].nodes.get(node)!
    const before = records.get(node)!
    const value = written.value === undefined ? undefined : freezeData(written.value)
    const found = expiriesOf(spec, written, value)
    const digest = written.status === 'present' ? digestOf(written.value) : undefined
    const changed = written.status !== before.status || digest !== before.digest
    const metaChanged = metaOf(written) !== metaOf(before)
    if (spec.coalesces && !changed && !metaChanged) return
    records.set(
      node,
      Object.freeze({
        ...written,
        ...(value !== undefined && { value }),
        ...(digest !== undefined && { digest })
      })
    )
    const seq = ++writeSeq
    lastWrite.set(node, seq)
    presented(node, found)
    if (derived) step!.derived.push({ node, digest: digest ?? written.status })
    const becamePresent = written.status === 'present' && !readable(before)
    for (const reader of readers.get(node) ?? []) {
      if (reader.mode === 'every') buffers.get(reader.key)!.push({ value, stamp: step!.stamp, seq })
      const wakes = reader.trigger
        ? changed || metaChanged || reader.mode !== 'latest'
        : becamePresent
      if (wakes && reader.operator) schedule(reader.operator)
    }
  }

  /** Hands `node`'s current record to its watchers again, as at a write. */
  const wake = (node: string) => {
    lastWrite.set(node, ++writeSeq)
    presented(node, expiries.get(node) ?? [])
    for (const reader of readers.get(node) ?? [])
      if (reader.mode === 'watch' && reader.operator) schedule(reader.operator)
  }

  /** The next expiry of `node` its watchers have not seen pass, while any watcher still runs. */
  const pendingExpiry = (node: string) => (isWatched(node) ? expiries.get(node)?.[0] : undefined)

  /** Takes every unread write on `reader`'s inputs, merged in delivery order. */
  const take = (reader: string, inputs: readonly string[]) =>
    inputs
      .flatMap(input => {
        const key = readerKey(reader, input)
        const taken = buffers.get(key) ?? []
        buffers.set(key, [])
        return taken.map(delivery => ({ ...delivery, from: input }))
      })
      .toSorted((left, right) => left.seq - right.seq)

  const evaluateMap = (op: Extract<OperatorSpec, { kind: 'map' }>) => {
    const inputs: Record<string, unknown> = {}
    let blocked: 'unknown' | 'failed' | undefined
    for (const [name, edge] of Object.entries(op.reads)) {
      if (edge.mode === 'every') continue
      const record = records.get(edge.node.id)!
      if (readable(record)) inputs[name] = record.value
      else blocked = blocked === 'failed' || record.status === 'failed' ? 'failed' : 'unknown'
    }
    if (blocked) return write(op.output, { status: blocked }, true)
    for (const [name, edge] of Object.entries(op.reads))
      if (edge.mode === 'every')
        inputs[name] = take(operatorReader(op.id), [name]).map(({ value, stamp }) => ({
          value,
          stamp
        }))
    write(op.output, { status: 'present', value: op.compute(inputs) }, true)
  }

  /** Each watched node written since `reader` last ran: its current record, at its last write. */
  const takeWatched = (reader: string, reads: OperatorSpec['reads']) =>
    Object.entries(reads).flatMap(([input, edge]) => {
      if (edge.mode !== 'watch') return []
      const seq = lastWrite.get(edge.node.id)
      const key = readerKey(reader, input)
      if (seq === undefined || seq <= (watched.get(key) ?? 0)) return []
      watched.set(key, seq)
      return [{ value: records.get(edge.node.id), stamp: step!.stamp, seq, from: input }]
    })

  const evaluateFold = (op: Extract<OperatorSpec, { kind: 'fold' }>) => {
    let state = records.get(op.output)!.value
    const emitted: { node: Node<unknown>; value: unknown }[] = []
    const reader = operatorReader(op.id)
    const inputs = [
      ...take(
        reader,
        Object.keys(op.reads).filter(input => op.reads[input]!.mode === 'every')
      ),
      ...takeWatched(reader, op.reads)
    ].toSorted((left, right) => left.seq - right.seq)
    for (const { from, value, stamp } of inputs) {
      const next = op.applyInput(state, { from, value, stamp })
      state = next.state
      emitted.push(...(next.emit ?? []))
    }
    if (op.afterInputs && inputs.length > 0) {
      const after = op.afterInputs(state, step!.stamp)
      state = after.state
      emitted.push(...(after.emit ?? []))
    }
    write(op.output, { status: 'present', value: state }, true)
    for (const { node, value } of emitted) {
      if (!op.emits.includes(node.id))
        throw new GraphDefinitionError(`${op.id} emitted to ${node.id}, which it does not own`)
      write(node.id, { status: 'present', value }, true)
    }
  }

  /**
   * Validates a push before it is queued, so a refused write never reaches a step, and freezes it,
   * so neither its evidence nor its journaled form changes after it is accepted.
   */
  const accept = (node: string, pushed: unknown): Pending => {
    const spec: NodeSpec | undefined = graph[layout].nodes.get(node)
    if (!spec) throw new WriteRefusedError(node, `it is not a node of ${graph.id}`)
    if (spec.kind !== 'level' && spec.kind !== 'occurrence')
      throw new WriteRefusedError(node, 'only its producer writes it')
    const written = spec.kind === 'level' ? levelWrite(node, pushed) : undefined
    const frozen = freezeData(pushed)
    return { node, pushed: frozen, written: written ?? { status: 'present', value: frozen } }
  }

  /** A write the runtime makes for a producer it owns: a clock or an effect's results. */
  const produced = (node: string, value: unknown): Pending => {
    const frozen = freezeData(value)
    return { node, pushed: frozen, written: { status: 'present', value: frozen } }
  }

  /** Runs one step: `wakes` names nodes whose watchers see them again, as {@link due} found them. */
  const run = (writes: readonly Pending[], stamp: Stamp, wakes: readonly string[] = []) => {
    const restorable = [records, buffers, lastWrite, watched, expiries] as Map<string, unknown>[]
    const saved = restorable.map(map =>
      [...map].map(([key, value]) => [key, Array.isArray(value) ? [...value] : value] as const)
    )
    const savedSeq = writeSeq
    step = { stamp, dirty: new Set(), reentries: new Map(), derived: [] }
    failedOperator = undefined
    try {
      for (const node of wakes) wake(node)
      for (const pending of writes) write(pending.node, pending.written, false)
      while (step.dirty.size > 0) {
        const op = graph[layout].operators.find(candidate => step!.dirty.has(candidate))!
        failedOperator = op.id
        step.dirty.delete(op)
        if (!step.reentries.has(op)) step.reentries.set(op, 0)
        if (op.kind === 'map') evaluateMap(op)
        else evaluateFold(op)
      }
      failedOperator = undefined
      return step.derived
    } catch (error) {
      for (const [index, map] of restorable.entries()) {
        map.clear()
        for (const [key, value] of saved[index]!) map.set(key, value)
      }
      writeSeq = savedSeq
      throw error
    } finally {
      step = undefined
    }
  }

  return {
    accept,
    produced,
    run,
    take,
    record: (node: string) => records.get(node),
    /** A node's value: its last write when present, else its initial value, else undefined. */
    read: (node: string) => {
      const record = records.get(node)
      return record && readable(record) ? record.value : undefined
    },
    propagating: () => step !== undefined,
    /** The earliest expiry some node's watchers have not seen pass, if any. */
    nextExpiry: () => {
      let next: number | undefined
      for (const node of expiries.keys()) {
        const expiry = pendingExpiry(node)
        if (expiry !== undefined && (next === undefined || expiry < next)) next = expiry
      }
      return next
    },
    /** The nodes holding an expiry at or before `at` that their watchers have not seen pass. */
    due: (at: number) =>
      [...expiries.keys()].filter(node => {
        const expiry = pendingExpiry(node)
        return expiry !== undefined && expiry <= at
      }),
    /** The operator the last step failed in, if one did. */
    failedOperator: () => failedOperator,
    /** From now on, evaluates only the operators in `operators`. */
    keepOnly: (operators: ReadonlySet<string>) => {
      kept = operators
    }
  }
}
