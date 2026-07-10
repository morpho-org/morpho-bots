import type { Address, Hex } from 'viem'

import { tryCatch } from '@repo/utils'

import type { Logger } from '../logger'

import { isExecutionRevert, revertReason as defaultRevertReason, TxSendError } from '../tx-error'
import { bumpFees } from './fee-policy'

/** Default blocks a pending tx may sit unconfirmed before the queue bumps its fee and replaces it. */
export const STUCK_BLOCKS = 4n

/** Default fee-bump attempts the queue makes on a stuck tx before dropping it. */
export const MAX_BUMP_ATTEMPTS = 3

export type TxRequest = { to: Address; data: Hex }

/**
 * Broadcasts a transaction and returns its assigned nonce + hash. On first submit `nonce` is omitted
 * and the signer claims the next one; on replacement the queue passes the original `nonce`
 * explicitly. If a first submit fails after claiming a nonce, the signer throws `TxSendError` with
 * that nonce so the queue can abort the tick instead of silently skipping a nonce-bearing send.
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
 * A tx leaving the pending set (confirm/revert/drop), surfaced to `onSettled` so a caller (the CLI
 * `queue`) can emit a terminal `outcome` wire record. `reason` is set only for drops
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
 * bigint-safe `stringify`/`parse` round-trip from `@repo/utils`, so a one-shot process can persist
 * the queue between invocations. Restored state is a HINT — the next `onBlock` reconciles every
 * entry against chain truth (receipts), so a stale or lost file degrades to restart semantics.
 */
export type PendingQueueState = {
  pending: Pending[]
  settledAt: [label: string, settledBlock: bigint][]
}

export type PendingQueue = {
  /**
   * Broadcasts a tx and tracks it. Resolves `{ submitted: true, nonce, txHash }` once the tx enters
   * the pending set (the CLI `queue` emits these on a `submitted` outcome record), and
   * `{ submitted: false }` when the send was skipped or failed hashlessly (nonce-sync failure, or a
   * non-`TxSendError` send throw) so nothing is tracked. A `TxSendError` (a nonce was claimed but no
   * hash returned) still throws — the caller aborts the tick. Callers key backoff-clear off
   * `submitted`: clearing only on a tx that actually entered `pending`.
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
  /**
   * Labels (`${id}:${borrower}`) the tick must NOT re-submit — its backpressure set. Covers
   * currently-pending txs AND, when `settledCooldownBlocks` is set, positions whose tx settled
   * within that many blocks. The cooldown matters when sends and reads use different RPCs: a tx
   * confirms on the send RPC before the (laggy) read RPC reflects the cleared position, so without
   * it the tick re-fires an already-liquidated borrower and lands a doomed revert.
   */
  inflightLabels(): ReadonlySet<string>
}

/**
 * In-memory pending-tx tracker. Nonce assignment is delegated to the injected `send`; the queue owns
 * confirmation, stuck-detection, and fee-bump/replace. The queue itself never touches disk: chain
 * truth wins, and a fresh instance re-derives from `getTransactionCount('pending')`. A caller that
 * outlives the process (one-shot ticks) may thread `dump()` output back in via `initialState` so
 * stuck-tx detection and fee-bumping survive restarts. When `syncNonce` is provided and the tracked
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
  settledCooldownBlocks = 0n,
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
  /** Blocks a settled label stays in the backpressure set; 0n (default) disables the cooldown. */
  settledCooldownBlocks?: bigint
  stuckBlocks?: bigint
  maxBumpAttempts?: number
  /** Formats send/replace failures for logs; default decodes standard `Error`/`Panic` reverts. */
  revertReason?: (error: unknown) => string
  /**
   * Optional observer invoked as each tracked tx leaves the pending set during `onBlock`
   * (confirm/revert/drop). The CLI `queue` wires this to emit terminal `outcome` wire records; the
   * queue's own state machine is unaffected by it.
   */
  onSettled?: (settlement: Settlement) => void
}): PendingQueue {
  // Entries are copied on restore so a caller-held `initialState` can't alias live queue mutations.
  const pending = new Map<number, Pending>(
    (initialState?.pending ?? []).map(entry => [entry.nonce, { ...entry }])
  )
  // label → block height at which its tx left `pending` (confirm/revert/drop). Keeps the label in the
  // backpressure set for `settledCooldownBlocks` so a just-acted position isn't re-submitted while
  // the read RPC still lags the confirmation. Pruned each `onBlock`. Unused when the cooldown is 0n.
  const settledAt = new Map<string, bigint>(initialState?.settledAt ?? [])

  // Remove a finished tx from `pending`, notify the optional `onSettled` observer, and (when the
  // cooldown is enabled) start its re-submission cooldown.
  function settle(
    entry: Pending,
    blockNumber: bigint,
    settlement: { status: SettlementStatus; reason?: string }
  ): void {
    pending.delete(entry.nonce)
    if (settledCooldownBlocks > 0n) settledAt.set(entry.label, blockNumber)
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
      logger.warn('tx.submit_failed', {
        label: args.label,
        reason: revertReason(sent.error),
        ...(sent.error instanceof TxSendError && sent.error.nonce !== undefined
          ? { nonce: sent.error.nonce }
          : {})
      })
      // No nonce means there is nothing to track or retry; the next tick re-evaluates from fresh
      // state. A claimed nonce with no hash is different: the signer has rolled its local cursor
      // back, and aborting the tick prevents the runner from counting this as submitted.
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
      settle(entry, blockNumber, { status: 'dropped', reason: 'max_bump_attempts' })
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
      settle(entry, blockNumber, { status: 'dropped', reason: 'fee_ceiling' })
      logger.warn('tx.dropped', { nonce: entry.nonce, txHash: entry.txHash, reason: 'fee_ceiling' })
      return
    }
    const replaced = await tryCatch(send({ ...entry.request, ...result.fees, nonce: entry.nonce }))
    if (replaced.error) {
      // A re-broadcast that reverts means the liquidation is no longer valid (e.g. the position was
      // cleared while our tx was in flight) — bumping it forever is futile, so drop it. A transient
      // RPC error instead counts as a spent attempt, so `maxBumpAttempts` still bounds the retries.
      if (isExecutionRevert(replaced.error)) {
        settle(entry, blockNumber, { status: 'dropped', reason: 'reverts_on_replace' })
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
          settle(entry, blockNumber, {
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
        logger.warn('tx.onblock_error', {
          nonce: entry.nonce,
          txHash: entry.txHash,
          reason: revertReason(error)
        })
      }
    }
    // Expire cooldowns so a position the bot acted on long ago is eligible again. By now the read RPC
    // has caught up, so an expired label only re-submits if it is genuinely still liquidatable.
    for (const [label, settledBlock] of settledAt) {
      if (blockNumber - settledBlock > settledCooldownBlocks) settledAt.delete(label)
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
      return {
        pending: [...pending.values()].map(entry => ({ ...entry })),
        settledAt: [...settledAt]
      }
    },
    inflightLabels() {
      const labels = new Set(settledAt.keys())
      for (const { label } of pending.values()) labels.add(label)
      return labels
    }
  }
}
