import type { EndCode, KernelActivity, Notice } from '@repo/kernel'

import { parseIntentId } from '@repo/controller'

import type { Logger } from './logger'

/** An act that ended without a broadcast, which each bot logs under its own event. */
export type NotSent = Readonly<{
  id: string
  intentId: string
  notice: Notice
  reason: string | null
  /** The kernel's {@link EndCode}, when the notice carries one. */
  code?: EndCode
}>

/**
 * `broadcast` counts each step's first broadcast at a nonce; `notSent` counts each send the
 * kernel rejected or withheld, and each act it refused.
 */
export type TxCounter = 'broadcast' | 'notSent'

/** The key an intent id acts for: the `id` every `tx.*` event carries. */
const keyOf = (intentId: string) => parseIntentId(intentId)?.key ?? intentId

/** The notices that end an intent: after one, it sends nothing more. */
export const INTENT_END_NOTICES: ReadonlySet<Notice> = new Set<Notice>([
  'refused',
  'abandoned',
  'settled',
  'compensated',
  'failed'
])

/**
 * Logs each kernel transaction as the `tx.*` events: `tx.sent`, `tx.bumped`,
 * `tx.broadcast_unknown`, `tx.submit_failed`, `tx.included` for each successful receipt whatever
 * the act's outcome, `tx.reverted`, `tx.cancelled` for an act cancelled before anything of it ran,
 * and `tx.dropped`, each kernel alarm as `kernel.alarm`, and the kernel leaving `starting` as
 * `kernel.running`. Each distinct outcome of a hash's receipt is logged once: a reorg that lands
 * the same outcome again is not, a changed one is.
 */
export const createTxReporter = (
  deps: Readonly<{
    logger: Logger
    reportNotSent: (fields: NotSent) => void
    count?: (counter: TxCounter) => void
  }>
) => {
  const { logger } = deps
  /** Each intent's broadcast transactions, hash to nonce, until the intent ends. */
  const sent = new Map<string, Map<string, number>>()
  /** Each receipt outcome logged, as `hash:success`, until its nonce record is final. */
  const included = new Set<string>()
  const outcomeOf = (hash: string, success: boolean) => `${hash}:${success}`
  const forget = (hashes: readonly string[]) => {
    for (const hash of hashes)
      for (const success of [true, false]) included.delete(outcomeOf(hash, success))
  }

  const reportSent = (activity: Extract<KernelActivity, { type: 'sent' }>) => {
    const fees = {
      maxFeePerGasWei: activity.maxFeePerGas,
      priorityFeePerGasWei: activity.maxPriorityFeePerGas
    }
    const fields = {
      id: keyOf(activity.intentId),
      intentId: activity.intentId,
      nonce: activity.nonce,
      txHash: activity.hash,
      ...fees,
      ...(activity.kind === 'step' ? {} : { kind: activity.kind })
    }
    if (activity.status === 'rejected' || activity.status === 'withheld') {
      deps.count?.('notSent')
      return logger.warn('tx.submit_failed', { ...fields, reason: activity.status })
    }
    const known = sent.get(activity.intentId)
    if (known?.has(activity.hash)) return
    const earlier = [...(known ?? [])].filter(([, nonce]) => nonce === activity.nonce)
    sent.set(activity.intentId, new Map(known).set(activity.hash, activity.nonce))
    if (activity.status === 'unknown') logger.warn('tx.broadcast_unknown', fields)
    const replaced = earlier.at(-1)?.[0]
    if (replaced === undefined) {
      if (activity.kind === 'step') deps.count?.('broadcast')
      if (activity.status === 'accepted') logger.info('tx.sent', fields)
      return
    }
    logger.info('tx.bumped', {
      id: fields.id,
      intentId: activity.intentId,
      nonce: activity.nonce,
      oldHash: replaced,
      newHash: activity.hash,
      attempt: earlier.length,
      ...fees
    })
  }

  const reportEnd = (notice: Extract<KernelActivity, { type: 'notice' }>) => {
    if (notice.notice === 'refused') deps.count?.('notSent')
    if (!INTENT_END_NOTICES.has(notice.notice)) return
    const id = keyOf(notice.intentId)
    const hashes = sent.get(notice.intentId)
    sent.delete(notice.intentId)
    if (notice.notice === 'settled' || (notice.included ?? []).length > 0) return
    const [first] = hashes ?? []
    const reason = notice.reason ?? null
    const code = notice.notice !== 'refused' && 'code' in notice ? notice.code : undefined
    if (!first)
      return deps.reportNotSent({
        id,
        intentId: notice.intentId,
        notice: notice.notice,
        reason,
        ...(code && { code })
      })
    const cancelled = code === 'cancelled'
    logger.warn(cancelled ? 'tx.cancelled' : 'tx.dropped', {
      id,
      intentId: notice.intentId,
      nonce: first[1],
      txHash: first[0],
      notice: notice.notice,
      reason
    })
  }

  const reportIncluded = (inclusion: Extract<KernelActivity, { type: 'included' }>) => {
    const outcome = outcomeOf(inclusion.hash, inclusion.success)
    if (included.has(outcome)) return
    included.add(outcome)
    const fields = {
      id: keyOf(inclusion.intentId),
      nonce: sent.get(inclusion.intentId)?.get(inclusion.hash) ?? null,
      txHash: inclusion.hash,
      blockNumber: inclusion.block
    }
    if (inclusion.success) logger.info('tx.included', fields)
    else logger.warn('tx.reverted', { ...fields, notice: null })
  }

  /** One kernel transition's activity, in order. */
  return (transition: readonly KernelActivity[]) => {
    for (const activity of transition) {
      if (activity.type === 'sent') reportSent(activity)
      if (activity.type === 'included' && parseIntentId(activity.intentId)) reportIncluded(activity)
      if (activity.type === 'alarm') logger.error('kernel.alarm', { reason: activity.reason })
      if (activity.type === 'running') logger.info('kernel.running')
      if (activity.type === 'final') forget(activity.hashes)
      if (activity.type === 'notice' && parseIntentId(activity.intentId)) reportEnd(activity)
    }
  }
}
