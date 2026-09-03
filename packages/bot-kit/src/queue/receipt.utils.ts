import type { Hex } from 'viem'

import { tryCatch } from '@repo/utils'

import type { GetReceipt, TxReceiptLite } from './pending-queue'

/**
 * Outcome of scanning every hash broadcast for one nonce.
 *
 * The `none`/`unknown` split is load-bearing: only `none` proves our transaction cannot have mined,
 * so only `none` may retire an entry. `unknown` means a read failed and the scan therefore cannot
 * distinguish "not mined" from "mined but unreadable" — a caller must treat it as transient and try
 * again on the next pass.
 */
type ReceiptScan =
  | { kind: 'mined'; txHash: Hex; receipt: TxReceiptLite }
  | { kind: 'none' }
  | { kind: 'unknown'; error: unknown }

/**
 * Finds the hash that mined among every hash broadcast for one nonce, newest first.
 *
 * A fee bump replaces a transaction but cannot un-broadcast it, so any hash in the list may be the
 * one the chain kept. A per-hash read failure is recorded and the scan CONTINUES rather than
 * aborting — otherwise a transient error on the newest hash would mask a mined original and the
 * queue would report a successful transaction as dropped.
 */
export const scanReceipts = async (
  getReceipt: GetReceipt,
  txHashes: readonly Hex[]
): Promise<ReceiptScan> => {
  let failure: { error: unknown } | null = null
  for (const txHash of txHashes) {
    const receipt = await tryCatch(getReceipt(txHash))
    if (receipt.error) {
      failure ??= { error: receipt.error }
      continue
    }
    if (receipt.data) return { kind: 'mined', txHash, receipt: receipt.data }
  }
  return failure ? { kind: 'unknown', error: failure.error } : { kind: 'none' }
}
