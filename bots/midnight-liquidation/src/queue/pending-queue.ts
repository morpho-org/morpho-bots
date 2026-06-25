import type { Address, Hex } from 'viem'

import { tryCatch } from '@repo/utils'

import type { Logger } from '../logger'

import { MAX_BUMP_ATTEMPTS, STUCK_BLOCKS } from '../constants'
import { isExecutionRevert, revertReason, TxSendError } from '../tx-error'
import { bumpFees } from './fee-policy'

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

type Pending = {
  nonce: number
  txHash: Hex
  request: TxRequest
  label: string
  submittedAtBlock: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  attempt: number
}

export type PendingQueue = {
  submit(args: {
    request: TxRequest
    label: string
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
    blockNumber: bigint
  }): Promise<void>
  onBlock(blockNumber: bigint): Promise<void>
  readonly size: number
  snapshot(): { nonce: number; txHash: Hex; attempt: number }[]
  /** Labels (`${id}:${borrower}`) of currently-pending txs — the tick's backpressure set. */
  inflightLabels(): ReadonlySet<string>
}

/**
 * In-memory pending-tx tracker. Nonce assignment is delegated to the injected `send`; the queue owns
 * confirmation, stuck-detection, and fee-bump/replace. State is not persisted — chain truth wins, so
 * a restart re-derives from `getTransactionCount('pending')`.
 */
export function createPendingQueue({
  send,
  getReceipt,
  getBaseFee,
  maxFeeWei,
  logger
}: {
  send: SendTx
  getReceipt: GetReceipt
  getBaseFee: GetBaseFee
  maxFeeWei: bigint
  logger: Logger
}): PendingQueue {
  const pending = new Map<number, Pending>()

  async function submit(args: {
    request: TxRequest
    label: string
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
    blockNumber: bigint
  }): Promise<void> {
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
      return
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
  }

  async function replaceStuck(entry: Pending, blockNumber: bigint, baseFee: bigint): Promise<void> {
    if (entry.attempt >= MAX_BUMP_ATTEMPTS) {
      pending.delete(entry.nonce)
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
      pending.delete(entry.nonce)
      logger.warn('tx.dropped', { nonce: entry.nonce, txHash: entry.txHash, reason: 'fee_ceiling' })
      return
    }
    const replaced = await tryCatch(send({ ...entry.request, ...result.fees, nonce: entry.nonce }))
    if (replaced.error) {
      // A re-broadcast that reverts means the liquidation is no longer valid (e.g. the position was
      // cleared while our tx was in flight) — bumping it forever is futile, so drop it. A transient
      // RPC error instead counts as a spent attempt, so MAX_BUMP_ATTEMPTS still bounds the retries.
      if (isExecutionRevert(replaced.error)) {
        pending.delete(entry.nonce)
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
          pending.delete(entry.nonce)
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
        if (blockNumber - entry.submittedAtBlock > STUCK_BLOCKS) {
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
    inflightLabels() {
      return new Set([...pending.values()].map(entry => entry.label))
    }
  }
}
