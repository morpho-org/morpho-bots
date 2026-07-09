import type { Account, Chain, Hex, Transport } from 'viem'

import { failover } from '@morpho-org/viem-dlc/transports'
import { tryCatch } from '@repo/utils'
import { createWalletClient, http, TransactionReceiptNotFoundError } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  getBlock,
  getTransactionCount,
  getTransactionReceipt,
  prepareTransactionRequest,
  sendTransaction
} from 'viem/actions'

import type { GetBaseFee, GetReceipt, SendTx, SyncNonce } from './queue/pending-queue'

import { TxSendError } from './tx-error'

const RPC_TIMEOUT_MS = 30_000

/** The signed-send primitives {@link createSigner} returns and `createPendingQueue` injects. */
export type Signer = {
  account: Account
  send: SendTx
  getReceipt: GetReceipt
  getBaseFee: GetBaseFee
  syncNonce: SyncNonce
}

/**
 * Builds the signed-send path the pending queue needs: a plain HTTP (optionally `failover`) wallet
 * client — deliberately NOT the viem-dlc `deployless` transport, which only wraps `eth_call` for the
 * lens — with a local pending-nonce cursor so sequential sends claim sequential nonces. Broadcasts
 * (and the nonce/receipt/base-fee reads) go to `sendRpcUrl` when set, else `rpcUrl`: a read relay
 * that can't actually relay sends would otherwise sink every tx. Returns the primitives
 * `createPendingQueue` injects: {@link SendTx}, {@link GetReceipt}, {@link GetBaseFee}, {@link SyncNonce}.
 */
export function createSigner(options: {
  chain: Chain
  rpcUrl: string
  rpcUrlFallback?: string | undefined
  /** Broadcast endpoint; sends + the signer's own reads go here (defaults to `rpcUrl`). */
  sendRpcUrl?: string | undefined
  privateKey: Hex
}): Signer {
  const rpc = (url: string) => http(url, { timeout: RPC_TIMEOUT_MS })
  // Sends + the signer's own reads run against the broadcast endpoint (sendRpcUrl ?? rpcUrl). Keeping
  // the nonce/receipt reads on the same endpoint we broadcast to is deliberate: a split view (read
  // nonce from A, send to B) is exactly what drifts the cursor out of sync.
  const sendUrl = options.sendRpcUrl ?? options.rpcUrl
  // viem-dlc's `failover` transport types its options as `unknown`, which isn't assignable to viem's
  // `Transport` (Record options) — the cast is safe (it's a valid runtime transport). The deployless
  // read client sidesteps this by re-wrapping `failover` in `deployless`.
  const transport = (
    options.rpcUrlFallback ? failover([rpc(sendUrl), rpc(options.rpcUrlFallback)]) : rpc(sendUrl)
  ) as Transport
  const account = privateKeyToAccount(options.privateKey)
  const client = createWalletClient({ account, chain: options.chain, transport })
  let nextNonce: number | undefined

  const readPendingNonce = (): Promise<number> =>
    getTransactionCount(client, { address: account.address, blockTag: 'pending' })

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
        account,
        to: req.to,
        data: req.data,
        maxFeePerGas: req.maxFeePerGas,
        maxPriorityFeePerGas: req.maxPriorityFeePerGas,
        nonce
      })
    } catch (error) {
      if (req.nonce === undefined) nextNonce = Math.min(nextNonce ?? nonce, nonce)
      throw error
    }
    try {
      const txHash = await sendTransaction(client, request)
      return { nonce, txHash }
    } catch (error) {
      if (req.nonce === undefined) nextNonce = Math.min(nextNonce ?? nonce, nonce)
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

  return { account, send, getReceipt, getBaseFee, syncNonce }
}
