import type { Logger } from '@repo/evm-kit'
import type { Address, Hex } from 'viem'

import { isExecutionRevert, revertReason as defaultRevertReason, TxSendError } from '@repo/evm-kit'
import { tryCatch } from '@repo/utils'

import { bumpFees } from './fee-policy'
import { isSignerError } from './signer-error'

/** Default blocks a pending tx may sit unconfirmed before the queue bumps its fee and replaces it. */
const STUCK_BLOCKS = 4n

/** Default fee-bump attempts the queue makes on a stuck tx before dropping it. */
const MAX_BUMP_ATTEMPTS = 3

export type TxRequest = { to: Address; data: Hex; value?: bigint }

/**
 * Broadcasts a transaction and returns its assigned nonce + hash. On first submit `nonce` is omitted
 * and the signer claims the next one; on replacement the queue passes the original `nonce`
 * explicitly. If a first submit fails after claiming a nonce, the signer throws `TxSendError` with
 * that nonce so the daemon can stop submitting until its next settlement sweep.
 */
export type SendTx = (
  request: TxRequest & { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; nonce?: number }
) => Promise<{ nonce: number; txHash: Hex }>

export type TxReceiptLite = { status: 'success' | 'reverted'; blockNumber: bigint }
export type GetReceipt = (txHash: Hex) => Promise<TxReceiptLite | null>
export type GetBaseFee = () => Promise<bigint>
/** Re-derives the signer's nonce cursor from chain truth; called when nothing is in flight. */
export type SyncNonce = () => Promise<void>

/** Terminal fate of a tracked tx, reported to the optional {@link PendingQueue} `onSettled` hook. */
export type SettlementStatus = 'confirmed' | 'reverted' | 'dropped'

/**
 * A tx leaving the pending set (confirm/revert/drop), surfaced to `onSettled` so the daemon can
 * append a terminal journal event. `reason` is set only for drops
 * (`max_bump_attempts` / `fee_ceiling` / `reverts_on_replace`).
 */
export type Settlement = {
  label: string
  nonce: number
  txHash: Hex
  status: SettlementStatus
  reason?: string
}

/** One tracked tx — the queue's full per-nonce record, exported so persisted state can carry it. */
export type Pending = {
  nonce: number
  txHash: Hex
  request: TxRequest
  label: string
  submittedAtBlock: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  attempt: number
}

/**
 * Restorable queue state: what `dump()` emits and `initialState` accepts. All fields survive the
 * bigint-safe `stringify`/`parse` round-trip from `@repo/utils`, so the daemon can persist the queue
 * across restarts. Restored state is a hint — the next `onBlock` reconciles every
 * entry against chain truth (receipts), so a stale or lost file degrades to restart semantics.
 */
export type PendingQueueState = {
  pending: Pending[]
}

export type PendingQueue = {
  /**
   * Broadcasts a tx and tracks it. Resolves `{ submitted: true, nonce, txHash }` once the tx enters
   * the pending set (the daemon acknowledges these as `submitted`), and
   * `{ submitted: false }` when the send was skipped or failed hashlessly (nonce-sync failure, or a
   * non-`TxSendError` send throw) so nothing is tracked. A `TxSendError` (a nonce was claimed but no
   * hash returned) still throws — the daemon stops sends until the next settlement sweep.
   */
  submit(args: {
    request: TxRequest
    label: string
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
    blockNumber: bigint
  }): Promise<{ submitted: true; nonce: number; txHash: Hex } | { submitted: false }>
  onBlock(blockNumber: bigint): Promise<void>
  readonly size: number
  snapshot(): { nonce: number; txHash: Hex; attempt: number }[]
  /** Restorable snapshot of the full queue state (unlike `snapshot()`, which is logs-only). */
  dump(): PendingQueueState
  /** Labels currently awaiting settlement, which must not be submitted twice. */
  inflightLabels(): ReadonlySet<string>
  /**
   * Retires the tracked tx at `nonce` as a `dropped` settlement with `reason` — the nonce-reconciler
   * seam for daemon reconciliation. When something outside the queue consumes a nonce (a manual
   * send from the same key, a competing signer, a reorg that replaces our tx), the tx we still track
   * under that nonce can never mine, so leaving it pending would wedge stuck-detection forever. The
   * daemon calls this to evict it through the same internal `settle` path a natural drop takes,
   * firing `onSettled` with the reason. Returns `false` when no pending entry has that nonce.
   */
  drop(nonce: number, reason: string): boolean
}

/**
 * In-memory pending-tx tracker. Nonce assignment is delegated to the injected `send`; the queue owns
 * confirmation, stuck-detection, and fee-bump/replace. The queue itself never touches disk: chain
 * truth wins, and a fresh instance re-derives from `getTransactionCount('pending')`. The daemon
 * threads `dump()` output back in via `initialState` so stuck-tx detection and fee-bumping survive
 * restarts. When `syncNonce` is provided and the tracked
 * set is empty, the next first-send re-syncs the cursor so a dropped (never-mined) tx can't strand
 * the cursor above chain truth and turn every later send into an unminable future nonce.
 */
export function createPendingQueue({
  send,
  getReceipt,
  getBaseFee,
  syncNonce,
  maxFeeWei,
  logger,
  initialState,
  stuckBlocks = STUCK_BLOCKS,
  maxBumpAttempts = MAX_BUMP_ATTEMPTS,
  revertReason = defaultRevertReason,
  onSettled
}: {
  send: SendTx
  getReceipt: GetReceipt
  getBaseFee: GetBaseFee
  /** When set, re-derives the signer's nonce cursor before a first send on an empty queue. */
  syncNonce?: SyncNonce
  maxFeeWei: bigint
  logger: Logger
  /** Seeds the queue from a prior `dump()` — a hint, reconciled against receipts on `onBlock`. */
  initialState?: PendingQueueState
  stuckBlocks?: bigint
  maxBumpAttempts?: number
  /** Formats send/replace failures for logs; default decodes standard `Error`/`Panic` reverts. */
  revertReason?: (error: unknown) => string
  /**
   * Optional observer invoked as each tracked tx leaves the pending set during `onBlock`
   * (confirm/revert/drop). The daemon wires this to append terminal journal events; the queue's own
   * state machine is unaffected by it.
   */
  onSettled?: (settlement: Settlement) => void
}): PendingQueue {
  // Entries are copied on restore so a caller-held `initialState` can't alias live queue mutations.
  const pending = new Map<number, Pending>(
    (initialState?.pending ?? []).map(entry => [entry.nonce, { ...entry }])
  )
  // Remove a finished tx from `pending` and notify the optional `onSettled` observer.
  function settle(entry: Pending, settlement: { status: SettlementStatus; reason?: string }): void {
    pending.delete(entry.nonce)
    onSettled?.({
      label: entry.label,
      nonce: entry.nonce,
      txHash: entry.txHash,
      status: settlement.status,
      ...(settlement.reason ? { reason: settlement.reason } : {})
    })
  }

  async function submit(args: {
    request: TxRequest
    label: string
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
    blockNumber: bigint
  }): Promise<{ submitted: true; nonce: number; txHash: Hex } | { submitted: false }> {
    // Nothing in flight → reconcile the cursor with chain before claiming a nonce. A failed sync
    // would leave a stale (possibly runaway) cursor, so skip the send this tick rather than risk a
    // future-nonce broadcast; the next tick retries from fresh state.
    if (syncNonce && pending.size === 0) {
      const synced = await tryCatch(syncNonce())
      if (synced.error) {
        logger.warn('nonce.sync_failed', { label: args.label, reason: revertReason(synced.error) })
        return { submitted: false }
      }
    }
    const sent = await tryCatch(
      send({
        ...args.request,
        maxFeePerGas: args.maxFeePerGas,
        maxPriorityFeePerGas: args.maxPriorityFeePerGas
      })
    )
    if (sent.error) {
      if (isSignerError(sent.error)) throw sent.error
      logger.warn('tx.submit_failed', {
        label: args.label,
        reason: revertReason(sent.error),
        ...(sent.error instanceof TxSendError && sent.error.nonce !== undefined
          ? { nonce: sent.error.nonce }
          : {})
      })
      // No nonce means there is nothing to track or retry; the next ingest re-evaluates from fresh
      // state. A claimed nonce with no hash is different: the signer has rolled its local cursor
      // back, and the engine prevents more sends until its next settlement sweep.
      if (sent.error instanceof TxSendError && sent.error.nonce !== undefined) throw sent.error
      return { submitted: false }
    }
    const { nonce, txHash } = sent.data
    pending.set(nonce, {
      nonce,
      txHash,
      request: args.request,
      label: args.label,
      submittedAtBlock: args.blockNumber,
      maxFeePerGas: args.maxFeePerGas,
      maxPriorityFeePerGas: args.maxPriorityFeePerGas,
      attempt: 0
    })
    logger.info('tx.sent', {
      label: args.label,
      nonce,
      txHash,
      maxFee: args.maxFeePerGas,
      priority: args.maxPriorityFeePerGas
    })
    return { submitted: true, nonce, txHash }
  }

  async function replaceStuck(entry: Pending, blockNumber: bigint, baseFee: bigint): Promise<void> {
    if (entry.attempt >= maxBumpAttempts) {
      settle(entry, { status: 'dropped', reason: 'max_bump_attempts' })
      logger.warn('tx.dropped', {
        nonce: entry.nonce,
        txHash: entry.txHash,
        reason: 'max_bump_attempts'
      })
      return
    }
    const result = bumpFees({
      maxFeePerGas: entry.maxFeePerGas,
      maxPriorityFeePerGas: entry.maxPriorityFeePerGas,
      baseFee,
      maxFeeWei
    })
    if (result.kind === 'drop') {
      settle(entry, { status: 'dropped', reason: 'fee_ceiling' })
      logger.warn('tx.dropped', { nonce: entry.nonce, txHash: entry.txHash, reason: 'fee_ceiling' })
      return
    }
    const replaced = await tryCatch(send({ ...entry.request, ...result.fees, nonce: entry.nonce }))
    if (replaced.error) {
      if (isSignerError(replaced.error)) throw replaced.error
      // A re-broadcast that reverts means the liquidation is no longer valid (e.g. the position was
      // cleared while our tx was in flight) — bumping it forever is futile, so drop it. A transient
      // RPC error instead counts as a spent attempt, so `maxBumpAttempts` still bounds the retries.
      if (isExecutionRevert(replaced.error)) {
        settle(entry, { status: 'dropped', reason: 'reverts_on_replace' })
        logger.warn('tx.dropped', {
          nonce: entry.nonce,
          txHash: entry.txHash,
          reason: 'reverts_on_replace',
          detail: revertReason(replaced.error)
        })
      } else {
        entry.attempt += 1
        logger.warn('tx.replace_failed', {
          nonce: entry.nonce,
          txHash: entry.txHash,
          attempt: entry.attempt,
          reason: revertReason(replaced.error)
        })
      }
      return
    }
    const oldHash = entry.txHash
    entry.txHash = replaced.data.txHash
    entry.maxFeePerGas = result.fees.maxFeePerGas
    entry.maxPriorityFeePerGas = result.fees.maxPriorityFeePerGas
    entry.submittedAtBlock = blockNumber
    entry.attempt += 1
    logger.info('tx.bumped', {
      nonce: entry.nonce,
      oldHash,
      newHash: replaced.data.txHash,
      attempt: entry.attempt,
      maxFee: result.fees.maxFeePerGas,
      priority: result.fees.maxPriorityFeePerGas
    })
  }

  async function onBlock(blockNumber: bigint): Promise<void> {
    let baseFee: bigint | null = null
    // Deleting the current key mid-iteration is well-defined for a Map; we never insert here.
    for (const entry of pending.values()) {
      // Per-entry isolation: one entry's transient read failure (getReceipt/getBaseFee) must not
      // abort the sweep for the rest of the queue. replaceStuck owns its own send-error handling.
      try {
        const receipt = await getReceipt(entry.txHash)
        if (receipt) {
          settle(entry, {
            status: receipt.status === 'success' ? 'confirmed' : 'reverted'
          })
          if (receipt.status === 'success') {
            logger.info('tx.confirmed', {
              nonce: entry.nonce,
              txHash: entry.txHash,
              blockNumber: receipt.blockNumber
            })
          } else {
            logger.warn('tx.reverted', {
              nonce: entry.nonce,
              txHash: entry.txHash,
              blockNumber: receipt.blockNumber
            })
          }
          continue
        }
        if (blockNumber - entry.submittedAtBlock > stuckBlocks) {
          baseFee ??= await getBaseFee()
          await replaceStuck(entry, blockNumber, baseFee)
        }
      } catch (error) {
        if (isSignerError(error)) throw error
        logger.warn('tx.onblock_error', {
          nonce: entry.nonce,
          txHash: entry.txHash,
          reason: revertReason(error)
        })
      }
    }
  }

  return {
    submit,
    onBlock,
    get size() {
      return pending.size
    },
    snapshot() {
      return [...pending.values()].map(entry => ({
        nonce: entry.nonce,
        txHash: entry.txHash,
        attempt: entry.attempt
      }))
    },
    dump() {
      return { pending: [...pending.values()].map(entry => ({ ...entry })) }
    },
    inflightLabels() {
      const labels = new Set<string>()
      for (const { label } of pending.values()) labels.add(label)
      return labels
    },
    drop(nonce, reason) {
      const entry = pending.get(nonce)
      if (!entry) return false
      logger.warn('tx.dropped', { nonce: entry.nonce, txHash: entry.txHash, reason })
      settle(entry, { status: 'dropped', reason })
      return true
    }
  }
}
