import type { Logger } from '@repo/bot-kit'

import { isHex, size, type Hex } from 'viem'

import type { MonitoringEvent } from '../../application/monitoring/monitoring-event'

type EventWriter = (event: MonitoringEvent) => void | Promise<void>

const hashField = (value: unknown): Hex | undefined =>
  typeof value === 'string' && isHex(value, { strict: true }) && size(value) === 32
    ? value
    : undefined

const numberField = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const blockField = (value: unknown): bigint | undefined =>
  typeof value === 'bigint' && value >= 0n ? value : undefined

const dropReason = (value: unknown) => {
  const reason = typeof value === 'string' ? value : undefined
  return ['max_bump_attempts', 'fee_ceiling', 'reverts_on_replace', 'nonce_consumed'].includes(
    reason ?? ''
  )
    ? reason
    : 'other'
}

const lifecycleEvent = (
  event: string,
  fields: Record<string, unknown>
): Extract<MonitoringEvent, { event: 'transaction.lifecycle' }> | undefined => {
  const nonce = numberField(fields.nonce)
  const txHash = hashField(event === 'tx.bumped' ? fields.newHash : fields.txHash)
  if (nonce === undefined || txHash === undefined) return undefined
  if (event === 'tx.sent')
    return { event: 'transaction.lifecycle', state: 'submitted', nonce, txHash }
  if (event === 'tx.broadcast_unknown') {
    return { event: 'transaction.lifecycle', state: 'broadcast-unknown', nonce, txHash }
  }
  if (event === 'tx.bumped') {
    return {
      event: 'transaction.lifecycle',
      state: 'replaced',
      nonce,
      txHash,
      ...(hashField(fields.oldHash) ? { previousTxHash: hashField(fields.oldHash) } : {}),
      ...(numberField(fields.attempt) === undefined ? {} : { attempt: numberField(fields.attempt) })
    }
  }
  if (event === 'tx.confirmed' || event === 'tx.reverted') {
    return {
      event: 'transaction.lifecycle',
      state: event === 'tx.confirmed' ? 'confirmed' : 'reverted',
      nonce,
      txHash,
      ...(blockField(fields.blockNumber) === undefined
        ? {}
        : { blockNumber: blockField(fields.blockNumber) })
    }
  }
  if (event === 'tx.dropped') {
    return {
      event: 'transaction.lifecycle',
      state: 'dropped',
      nonce,
      txHash,
      reason: dropReason(fields.reason)
    }
  }
  return undefined
}

/**
 * Projects bot-kit signer and queue logs into the sanitized quoter monitoring contract.
 * @param writeEvent - Optional CLI monitoring writer.
 * @returns A non-throwing logger that records transaction hashes, nonces, replacements, and outcomes.
 * @remarks Provider messages, calldata, targets, fees, and credentials are discarded. Writer
 * failures never interrupt transaction reconciliation.
 */
export const createQuoterTransactionLogger = (writeEvent?: EventWriter): Logger => {
  const emit = (event: string, fields: Record<string, unknown> = {}) => {
    const projected = lifecycleEvent(event, fields)
    if (!projected || !writeEvent) return
    try {
      void Promise.resolve(writeEvent(projected)).catch(() => {})
    } catch {
      return
    }
  }
  return { debug: emit, info: emit, warn: emit, error: emit }
}
