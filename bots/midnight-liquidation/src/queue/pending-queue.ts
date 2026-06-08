import type { Address, Hex } from 'viem'

import type { Logger } from '../logger'

import { MAX_BUMP_ATTEMPTS, STUCK_BLOCKS } from '../constants'
import { bumpFees } from './fee-policy'

export type TxRequest = { to: Address; data: Hex }

/**
 * Broadcasts a transaction and returns its assigned nonce + hash. On first submit `nonce` is
 * omitted and viem's `createNonceManager` claims the next one; on replacement the queue passes the
 * original `nonce` explicitly to bypass the manager. The daemon supplies the real implementation
 * (CRTR-2585); the queue stays agnostic so its state machine is testable without a chain.
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
}

/**
 * In-memory pending-tx tracker. Nonce assignment is delegated to viem's nonce manager (via the
 * injected `send`); the queue owns confirmation, stuck-detection, and fee-bump/replace. State is
 * not persisted — chain truth wins, so a restart re-derives from `getTransactionCount('pending')`.
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
    const { nonce, txHash } = await send({
      ...args.request,
      maxFeePerGas: args.maxFeePerGas,
      maxPriorityFeePerGas: args.maxPriorityFeePerGas
    })
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
    const replaced = await send({ ...entry.request, ...result.fees, nonce: entry.nonce })
    const oldHash = entry.txHash
    entry.txHash = replaced.txHash
    entry.maxFeePerGas = result.fees.maxFeePerGas
    entry.maxPriorityFeePerGas = result.fees.maxPriorityFeePerGas
    entry.submittedAtBlock = blockNumber
    entry.attempt += 1
    logger.info('tx.bumped', {
      nonce: entry.nonce,
      oldHash,
      newHash: replaced.txHash,
      attempt: entry.attempt,
      maxFee: result.fees.maxFeePerGas,
      priority: result.fees.maxPriorityFeePerGas
    })
  }

  async function onBlock(blockNumber: bigint): Promise<void> {
    let baseFee: bigint | null = null
    // Deleting the current key mid-iteration is well-defined for a Map; we never insert here.
    for (const entry of pending.values()) {
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
    }
  }
}
