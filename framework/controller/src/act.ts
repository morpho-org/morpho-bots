import type { Data, Keyed, Node } from '@repo/engine'
import type {
  Authored,
  Conflicts,
  DecisionRecord,
  BlockRef,
  Fact,
  Id,
  KernelEvent,
  KernelRequest,
  PlanInput,
  StepSpec
} from '@repo/kernel'

import { GraphDefinitionError, keyRecord } from '@repo/engine'
import { ABSENT, factId } from '@repo/kernel'

import { EvidenceDefectError } from './errors'

declare const domainBrand: unique symbol

/** A keyed fact node registered with the kernel of domain `D`, and with no other. */
export type FactNode<D extends string, V = unknown> = Node<Keyed<V>> &
  Readonly<{ [domainBrand]: D }>

/** One key of a {@link FactNode} as it reads now, which only {@link factOf} produces. */
export type FactReading<D extends string> = Readonly<{
  fact: Fact
  expiry?: number
  [domainBrand]: D
}>

/** A plan for the kernel of domain `D`, built by {@link act} or {@link withdrawal}. */
export type AuthoredPlan<D extends string> = Readonly<PlanInput> & Authored<'plan', D>

type Advance = Extract<KernelRequest, { type: 'Advance' }>

/**
 * One kernel's fact registry. Every fact node is registered with exactly one domain, and
 * `facts()` hands the kernel its list and closes registration, so no plan can rest on a fact the
 * kernel does not watch.
 */
export type KernelDomain<D extends string> = Readonly<{
  name: D
  fact: <V>(node: Node<Keyed<V>>) => FactNode<D, V>
  facts: () => readonly Node<Keyed<unknown>>[]
}>

const owners = new WeakMap<Node<Keyed<unknown>>, KernelDomain<string>>()
const origins = new WeakMap<FactReading<string>, Node<Keyed<unknown>>>()

export const kernelDomain = <const D extends string>(name: D): KernelDomain<D> => {
  const nodes: Node<Keyed<unknown>>[] = []
  let sealed = false
  const handle: KernelDomain<D> = {
    name,
    fact: <V>(node: Node<Keyed<V>>) => {
      const owner = owners.get(node)
      if (owner !== undefined)
        throw new GraphDefinitionError(`fact ${node.id} is already registered with ${owner.name}`)
      if (sealed)
        throw new GraphDefinitionError(`fact ${node.id} registered after ${name} took its facts`)
      owners.set(node, handle)
      nodes.push(node)
      return node as FactNode<D, V>
    },
    facts: () => {
      sealed = true
      return [...nodes]
    }
  }
  return handle
}

/** The block `basis` was read at, which the kernel checks for canonicality. */
const chainBasis = (id: Id, basis: Data): BlockRef => {
  if (typeof basis === 'object' && basis !== null && !Array.isArray(basis)) {
    const { block, blockHash } = basis as Readonly<Record<string, Data | undefined>>
    if (Number.isSafeInteger(block) && (block as number) >= 0 && typeof blockHash === 'string')
      return Object.freeze({ block: block as number, blockHash })
  }
  throw new EvidenceDefectError(`${id} was read at a basis that names no block`)
}

/**
 * The evidence that `key` of a fact node still reads as it does now: its digest, or that it
 * is absent, with the block it was read at and when the read expires. Undefined while the key is
 * unknown or failed, which authorizes nothing.
 * @throws EvidenceDefectError - for a key read at a basis that names no block.
 */
export const factOf = <D extends string>(
  node: FactNode<D>,
  keyed: Keyed<unknown> | undefined,
  key: string
): FactReading<D> | undefined => {
  if (keyed === undefined) return undefined
  const fact = keyRecord(keyed, key)
  if (fact.status !== 'present' && fact.status !== 'absent') return undefined
  const id = factId(node.id, key)
  const version = fact.status === 'present' ? fact.digest : ABSENT
  const reading = Object.freeze({
    fact: Object.freeze({ id, version, basis: chainBasis(id, fact.basis) }),
    ...(fact.expiry !== undefined && { expiry: fact.expiry })
  }) as FactReading<D>
  origins.set(reading, node)
  return reading
}

/**
 * What a decision rests on: the facts it read, the block it read anything else at, and when what
 * it decided stops holding.
 */
type Grounds<D extends string> = Readonly<{
  restsOn: readonly FactReading<D>[]
  readAt?: number
  validUntil?: number
  decision?: DecisionRecord
}>

/**
 * The kernel fields a decision's grounds imply: every fact as evidence, the latest block any of
 * it was read at, and the earliest of `validUntil` and every fact's expiry as `notAfter`. Throws
 * on a reading {@link factOf} did not make from a fact registered with `domain`, and on grounds
 * that name no deadline.
 */
const groundsOf = <D extends string>(domain: KernelDomain<D>, grounds: Grounds<D>) => {
  const { restsOn, readAt, validUntil, decision } = grounds
  if (restsOn.length === 0)
    throw new EvidenceDefectError(`an act on ${domain.name} rests on no fact`)
  for (const reading of restsOn) {
    const node = origins.get(reading)
    if (node === undefined || owners.get(node) !== domain)
      throw new EvidenceDefectError(`${reading.fact.id} is not a fact of ${domain.name}`)
  }
  const blocks = restsOn.map(({ fact }) => fact.basis.block)
  const deadlines = [validUntil, ...restsOn.map(({ expiry }) => expiry)].filter(
    (deadline): deadline is number => deadline !== undefined
  )
  if (deadlines.length === 0)
    throw new EvidenceDefectError(`an act on ${domain.name} rests on no fact with an expiry`)
  return {
    basisBlock: Math.max(readAt ?? 0, ...blocks),
    evidence: Object.freeze(restsOn.map(({ fact }) => fact)),
    notAfter: Math.min(...deadlines),
    ...(decision && { decision })
  }
}

type Planned = Readonly<{
  intentId: Id
  steps: readonly StepSpec[]
  /** Mandatory, so a plan that conflicts with nothing says so with `{}`. */
  conflicts: Conflicts
  submissionId?: Id
  supersedes?: Id
  maxSpendWei?: bigint
}>

/** A conflict set naming nothing is the same to the kernel as none, and is left out. */
const planOf = (spec: Planned) => {
  const { reads = [], writes = [] } = spec.conflicts
  return {
    intentId: spec.intentId,
    steps: spec.steps,
    ...(reads.length + writes.length > 0 && { conflicts: spec.conflicts }),
    ...(spec.submissionId !== undefined && { submissionId: spec.submissionId }),
    ...(spec.supersedes !== undefined && { supersedes: spec.supersedes }),
    ...(spec.maxSpendWei !== undefined && { maxSpendWei: spec.maxSpendWei })
  }
}

/**
 * A plan resting on facts of `domain`, the only way to build one that carries evidence.
 * `submissionId` and `decision` pass through as a saga's identity, which alone cannot rebuild a
 * saga after a restart.
 */
export const act = <D extends string>(
  domain: KernelDomain<D>,
  spec: Planned & Grounds<NoInfer<D>>
): AuthoredPlan<D> => {
  const plan: PlanInput = { ...planOf(spec), ...groundsOf(domain, spec) }
  return Object.freeze(plan) as AuthoredPlan<D>
}

/**
 * A plan carrying no evidence, decided at `basisBlock`, which nothing of leaves past `expiresAt`.
 * The kernel never refuses a risk-reducing plan for its evidence, and admits one that is not on
 * its validators' readings alone.
 */
export const withdrawal = <D extends string>(
  _domain: KernelDomain<D>,
  spec: Planned & Readonly<{ basisBlock: number; expiresAt: number; decision?: DecisionRecord }>
): AuthoredPlan<D> => {
  const plan: PlanInput = {
    ...planOf(spec),
    basisBlock: spec.basisBlock,
    notAfter: spec.expiresAt,
    ...(spec.decision && { decision: spec.decision })
  }
  return Object.freeze(plan) as AuthoredPlan<D>
}

/** The `Advance` of a plan parked before `stage`, resting on its facts read again. */
export const advance = <D extends string>(
  domain: KernelDomain<D>,
  spec: Readonly<{ intentId: Id; stage: number }> & Grounds<NoInfer<D>>
): Advance => {
  const request: Extract<KernelEvent, { type: 'Advance' }> = {
    type: 'Advance',
    intentId: spec.intentId,
    stage: spec.stage,
    ...groundsOf(domain, spec)
  }
  return Object.freeze(request) as Advance
}
