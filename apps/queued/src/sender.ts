import type { RemoteSigner } from '@repo/signer/client'
import type { Chain } from 'viem'

import { TxSendError } from '@repo/bot-kit'
import { tryCatch } from '@repo/utils'
import { createWalletClient, http, TransactionReceiptNotFoundError } from 'viem'
import {
  getBlock,
  getTransactionCount,
  getTransactionReceipt,
  prepareTransactionRequest,
  sendRawTransaction
} from 'viem/actions'

import type { GetBaseFee, GetReceipt, SendTx, SyncNonce } from './pending-queue'

import { isSignerError } from './signer-error'

type Sender = {
  address: RemoteSigner['address']
  send: SendTx
  getReceipt: GetReceipt
  getBaseFee: GetBaseFee
  syncNonce: SyncNonce
}

/**
 * Builds the signed-send path with a local pending-nonce cursor. One RPC is authoritative for
 * preparation, nonce reads, broadcast, receipts, and replacement state.
 */
export function createSender(options: {
  chain: Chain
  rpcUrl: string
  signer: RemoteSigner
}): Sender {
  const client = createWalletClient({ chain: options.chain, transport: http(options.rpcUrl) })
  let nextNonce: number | undefined

  const readPendingNonce = (): Promise<number> =>
    getTransactionCount(client, { address: options.signer.address, blockTag: 'pending' })

  // Reclaim a runaway cursor: a tx that was broadcast but never mined (then dropped from our tracked
  // set) leaves the cursor above chain truth, so every later send is an unminable future nonce. The
  // queue calls this when nothing is in flight, collapsing the cursor back to the chain's pending
  // nonce. With txs genuinely in flight the cursor must stay ahead, so the queue only syncs on empty.
  const syncNonce: SyncNonce = async () => {
    nextNonce = await readPendingNonce()
  }

  const claimNonce = async (): Promise<number> => {
    nextNonce ??= await readPendingNonce()
    const nonce = nextNonce
    nextNonce += 1
    return nonce
  }

  // First send: claim from the local cursor and pass an explicit nonce into prepare/send. If the
  // hashless broadcast fails, roll the cursor back so the next tick can retry the same nonce.
  // Replacement: the queue passes an explicit `nonce`, which does not move the cursor.
  const send: SendTx = async req => {
    const nonce = req.nonce ?? (await claimNonce())
    let request: Awaited<ReturnType<typeof prepareTransactionRequest>>
    try {
      request = await prepareTransactionRequest(client, {
        account: options.signer.address,
        to: req.to,
        data: req.data,
        value: req.value ?? 0n,
        maxFeePerGas: req.maxFeePerGas,
        maxPriorityFeePerGas: req.maxPriorityFeePerGas,
        nonce
      })
    } catch (error) {
      if (req.nonce === undefined) nextNonce = Math.min(nextNonce ?? nonce, nonce)
      throw error
    }
    try {
      const serializedTransaction = await options.signer.signPreparedTransaction(request)
      const txHash = await sendRawTransaction(client, { serializedTransaction })
      return { nonce, txHash }
    } catch (error) {
      if (req.nonce === undefined) nextNonce = Math.min(nextNonce ?? nonce, nonce)
      if (isSignerError(error)) throw error
      throw new TxSendError(error, nonce)
    }
  }

  const getReceipt: GetReceipt = async txHash => {
    const { data, error } = await tryCatch(getTransactionReceipt(client, { hash: txHash }))
    if (error) {
      // Only "not found yet" means still-pending → null; let transport errors propagate so a
      // transient RPC failure isn't misread as pending and doesn't suppress stuck-detection.
      if (error instanceof TransactionReceiptNotFoundError) return null
      throw error
    }
    return { status: data.status, blockNumber: data.blockNumber ?? 0n }
  }

  const getBaseFee: GetBaseFee = async () => {
    const block = await getBlock(client, { blockTag: 'latest' })
    if (block.baseFeePerGas === null) throw new Error('chain returned no baseFeePerGas')
    return block.baseFeePerGas
  }

  return { address: options.signer.address, send, getReceipt, getBaseFee, syncNonce }
}
