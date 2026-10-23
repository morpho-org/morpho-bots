import type { GraphBuilder, Keyed, Node, Stream } from '@repo/engine'
import type { Fact, KernelRequest, KernelState, Plan } from '@repo/kernel'

import { emitTo, watch } from '@repo/engine'

import type { FactNode, FactReading, KernelDomain } from './act'

import { advance, factOf } from './act'

/** An advance the workflow sent the kernel: a parked plan's next stage, on facts read at `block`. */
export type WorkflowEvent = Readonly<{ intentId: string; stage: number; block: number }>

type Workflow = Readonly<{
  kernelState?: KernelState
  facts: Readonly<Record<string, Keyed<unknown>>>
  /** Per parked plan, the advance last sent for it, so the same evidence is never sent twice. */
  sent: Readonly<Record<string, string>>
}>

export type WorkflowOptions<D extends string> = Readonly<{
  domain: KernelDomain<D>
  state: Node<KernelState>
  /** The fact nodes plans' evidence names. */
  facts: readonly FactNode<NoInfer<D>>[]
  /** Where advances go: a node the kernel takes as one of its `requests`, which this fold writes. */
  requests: Stream<KernelRequest>
}>

/**
 * The current reading of every fact `plan` rests on, if each still holds the version the plan was
 * decided on, read at or after the plan's last inclusion, with an expiry; otherwise nothing, and
 * the plan waits.
 */
const freshEvidence = <D extends string>(
  workflow: Workflow,
  nodes: readonly FactNode<D>[],
  plan: Plan
): readonly FactReading<D>[] | undefined => {
  const facts = plan.evidence ?? []
  if (facts.length === 0) return undefined
  const read = facts.map((fact: Fact) => {
    const node = nodes.find(candidate => fact.id.startsWith(`${candidate.id}/`))
    if (node === undefined) return undefined
    const current = factOf(node, workflow.facts[node.id], fact.id.slice(node.id.length + 1))
    if (current?.fact.version !== fact.version || current.expiry === undefined) return undefined
    return current.fact.basis.block < (plan.lastInclusion ?? 0) ? undefined : current
  })
  return read.every(current => current !== undefined) ? read : undefined
}

/**
 * Advances each plan the kernel parks at a stage boundary once every fact its evidence names reads
 * at the same version again, read at or after the plan's own last inclusion: the decision it was
 * admitted on still holds after its own effect. A fact that moved leaves the plan parked, for the
 * bot's decision to supersede or for its finished stage's deadline to end it. Nothing here is a
 * second store of the workflow: it reads the kernel's plans, and the kernel judges every advance.
 */
export const declareWorkflow = <D extends string>(
  g: GraphBuilder,
  id: string,
  options: WorkflowOptions<D>
) => {
  const events = g.node<WorkflowEvent>(`${id}.events`)
  const { requests } = options

  const advances = (workflow: Workflow) => {
    const emit = []
    const sent: Record<string, string> = {}
    for (const plan of Object.values(workflow.kernelState?.plans ?? {})) {
      if (plan.status !== 'executing' || plan.phase !== 'awaiting-advance') continue
      const evidence = freshEvidence(workflow, options.facts, plan)
      if (evidence === undefined) {
        if (workflow.sent[plan.intentId] !== undefined)
          sent[plan.intentId] = workflow.sent[plan.intentId]!
        continue
      }
      const sending = JSON.stringify([
        plan.cursor,
        evidence.map(({ fact, expiry }) => [fact, expiry])
      ])
      sent[plan.intentId] = sending
      if (workflow.sent[plan.intentId] === sending) continue
      const request = advance(options.domain, {
        intentId: plan.intentId,
        stage: plan.cursor,
        restsOn: evidence,
        ...(plan.lastInclusion !== undefined && { readAt: plan.lastInclusion }),
        ...(plan.decision && { decision: plan.decision })
      })
      emit.push(
        emitTo(requests, request),
        emitTo(events, { intentId: plan.intentId, stage: plan.cursor, block: request.basisBlock })
      )
    }
    return { state: { ...workflow, sent }, emit }
  }

  const state = g.fold(id, {
    reads: {
      kernel: watch(options.state),
      ...Object.fromEntries(options.facts.map((node, i) => [`fact${i}`, watch(node)]))
    },
    emits: [requests, events],
    initial: { facts: {}, sent: {} } as Workflow,
    applyInput: (workflow, input) => {
      if (input.from === 'kernel')
        return { state: { ...workflow, kernelState: input.value.value as KernelState } }
      const node = options.facts[Number(String(input.from).slice(4))]!
      const keyed = (input.value as { value?: Keyed<unknown> }).value
      const { [node.id]: _, ...facts } = workflow.facts
      return { state: { ...workflow, facts: keyed ? { ...facts, [node.id]: keyed } : facts } }
    },
    afterInputs: advances
  })
  return { state, events }
}
