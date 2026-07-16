import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Settlement } from './pending-queue'

/** One line of the outcomes journal — a terminal queue settlement, timestamped and chain-tagged. */
export type JournalEvent = {
  kind: 'queue'
  chainId: number
  at: string
  label: string
  status: string
  txHash: string
  nonce: number
  reason?: string
}

/**
 * A lightweight append-only audit trail of what the bot did: every terminal queue settlement
 * (confirm/revert/drop) is appended as one JSON line to `path`. Wire the returned `record` into the
 * pending queue's `onSettled` hook. Parent directories are created on construction; each append is a
 * synchronous `appendFileSync` (one short line per settled tx — never a hot path).
 */
export function createOutcomeJournal(deps: { path: string; chainId: number }): {
  record: (settlement: Settlement) => void
} {
  mkdirSync(dirname(deps.path), { recursive: true })
  return {
    record(settlement) {
      const event: JournalEvent = {
        kind: 'queue',
        chainId: deps.chainId,
        at: new Date().toISOString(),
        label: settlement.label,
        status: settlement.status,
        txHash: settlement.txHash,
        nonce: settlement.nonce,
        ...(settlement.reason ? { reason: settlement.reason } : {})
      }
      appendFileSync(deps.path, `${JSON.stringify(event)}\n`)
    }
  }
}
