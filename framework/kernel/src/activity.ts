import type { Command, KernelActivity, KernelEvent, KernelState, NonceRecord, Plan } from './types'

/** What one transition deleted from the state, as it stood just before. */
export type Pruned = { nonces: NonceRecord[]; plans: Plan[] }

const sends = (before: KernelState, records: readonly NonceRecord[]): KernelActivity[] =>
  records.flatMap(record =>
    record.candidates.flatMap((candidate, index) => {
      const was = before.nonces[record.nonce]?.candidates.find(c => c.hash === candidate.hash)
      if (candidate.sent === 'unsent' || candidate.sent === (was?.sent ?? 'unsent')) return []
      const { intentId, step, kind, hash, sent: status, maxFeePerGas } = candidate
      const fees = { maxFeePerGas, maxPriorityFeePerGas: candidate.maxPriorityFeePerGas }
      const { nonce } = record
      const replaces = record.candidates[index - 1]?.hash
      return [
        {
          type: 'sent',
          intentId,
          step,
          kind,
          nonce,
          hash,
          status,
          ...fees,
          ...(replaces && { replaces })
        } as const
      ]
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

const resolutions = (before: KernelState, records: readonly NonceRecord[]) =>
  records.flatMap((record): KernelActivity[] => {
    const { resolution, nonce } = record
    const was = before.nonces[nonce]?.resolution
    if (
      !resolution ||
      (was?.winner === resolution.winner &&
        was.blockHash === resolution.blockHash &&
        was.success === resolution.success)
    )
      return []
    const { block, blockHash, winner, success, confirmed } = resolution
    return [{ type: 'resolved', nonce, block, blockHash, winner, success, confirmed }]
  })

const entries = (before: KernelState, after: KernelState): KernelActivity[] => {
  const changed = Object.entries(after.entries).flatMap(([id, entry]): KernelActivity[] => {
    const from = before.entries[id]?.state
    if (from === entry.state) return []
    const { intentId, state: to, retiredBy: reason } = entry
    return [{ type: 'entry', id, intentId, ...(from && { from }), to, ...(reason && { reason }) }]
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
 * restores sends, resolutions and entries a previous run already reported, so it reports none.
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
  const records = [...Object.values(after.nonces), ...pruned.nonces]
  return [
    ...(restored ? [] : sends(before, records)),
    ...releases(before, after, event),
    ...inclusions(before, [...Object.values(after.plans), ...pruned.plans]),
    ...(restored ? [] : resolutions(before, records)),
    ...pruned.nonces.map(
      (record): KernelActivity => ({
        type: 'final',
        nonce: record.nonce,
        hashes: record.candidates.map(c => c.hash)
      })
    ),
    ...(restored ? [] : entries(before, after)),
    ...commands
      .filter(command => command.type === 'notify')
      .map(({ type: _, ...notice }): KernelActivity => ({ type: 'notice', ...notice })),
    ...alarms.map((reason): KernelActivity => ({ type: 'alarm', reason })),
    ...(before.lifecycle.kind === 'starting' && after.lifecycle.kind === 'running'
      ? [{ type: 'running' } as const]
      : [])
  ]
}
