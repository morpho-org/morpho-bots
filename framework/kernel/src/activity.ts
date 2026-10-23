import type { Command, KernelActivity, KernelEvent, KernelState, NonceRecord, Plan } from './types'

/** What one transition deleted from the state, as it stood just before. */
export type Pruned = { nonces: NonceRecord[]; plans: Plan[] }

const sends = (before: KernelState, records: readonly NonceRecord[]): KernelActivity[] =>
  records.flatMap(record =>
    record.candidates.flatMap(candidate => {
      const was = before.nonces[record.nonce]?.candidates.find(c => c.hash === candidate.hash)
      if (candidate.sent === 'unsent' || candidate.sent === (was?.sent ?? 'unsent')) return []
      const { intentId, step, kind, hash, sent: status } = candidate
      return [{ type: 'sent', intentId, step, kind, nonce: record.nonce, hash, status } as const]
    })
  )

const releases = (before: KernelState, after: KernelState, event: KernelEvent) =>
  Object.entries(before.outstanding).flatMap(([request, outstanding]): KernelActivity[] => {
    if (outstanding.kind !== 'release' || after.outstanding[Number(request)]) return []
    const outcome =
      event.type === 'Released' && event.request === Number(request) ? event.outcome : 'unknown'
    const step = before.plans[outstanding.plan]?.cursor ?? 0
    return [{ type: 'released', intentId: outstanding.plan, step, outcome }]
  })

const inclusions = (before: KernelState, plans: readonly Plan[]) =>
  plans.flatMap(plan => {
    const known = before.plans[plan.intentId]?.included ?? []
    return (plan.included ?? [])
      .filter(({ step, hash }) => !known.some(k => k.step === step && k.hash === hash))
      .map(
        (inclusion): KernelActivity => ({ type: 'included', intentId: plan.intentId, ...inclusion })
      )
  })

const entries = (before: KernelState, after: KernelState): KernelActivity[] => {
  const changed = Object.entries(after.entries).flatMap(([id, entry]): KernelActivity[] => {
    const from = before.entries[id]?.state
    if (from === entry.state) return []
    return [{ type: 'entry', id, intentId: entry.intentId, ...(from && { from }), to: entry.state }]
  })
  const dropped = Object.entries(before.entries).flatMap(([id, entry]): KernelActivity[] =>
    after.entries[id] || entry.state === 'retired'
      ? []
      : [{ type: 'entry', id, intentId: entry.intentId, from: entry.state, to: 'dropped' }]
  )
  return [...changed, ...dropped]
}

/**
 * Everything one transition did that a bot may count, the records it pruned included. `Start`
 * restores sends and entries a previous run already reported, so it reports neither.
 */
export const activityOf = (
  before: KernelState,
  event: KernelEvent,
  after: KernelState,
  commands: readonly Command[],
  pruned: Pruned,
  alarms: readonly string[] = []
): KernelActivity[] => {
  const restored = event.type === 'Start'
  return [
    ...(restored ? [] : sends(before, [...Object.values(after.nonces), ...pruned.nonces])),
    ...releases(before, after, event),
    ...inclusions(before, [...Object.values(after.plans), ...pruned.plans]),
    ...(restored ? [] : entries(before, after)),
    ...commands
      .filter(command => command.type === 'notify')
      .map(({ type: _, ...notice }): KernelActivity => ({ type: 'notice', ...notice })),
    ...alarms.map((reason): KernelActivity => ({ type: 'alarm', reason }))
  ]
}
