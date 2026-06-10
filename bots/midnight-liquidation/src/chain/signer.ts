import type { Account, Transport } from 'viem'

import { failover } from '@morpho-org/viem-dlc/transports'
import { tryCatch } from '@repo/utils'
import { createWalletClient, http, TransactionReceiptNotFoundError } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  getBlock,
  getTransactionReceipt,
  prepareTransactionRequest,
  sendTransaction
} from 'viem/actions'
import { createNonceManager, jsonRpc } from 'viem/nonce'

import type { Config } from '../config'
import type { GetBaseFee, GetReceipt, SendTx } from '../queue/pending-queue'

const RPC_TIMEOUT_MS = 30_000

type Signer = {
  account: Account
  send: SendTx
  getReceipt: GetReceipt
  getBaseFee: GetBaseFee
}

/**
 * Builds the signed-send path the pending queue needs: a plain HTTP (optionally `failover`) wallet
 * client — deliberately NOT the viem-dlc `deployless` transport, which only wraps `eth_call` for the
 * lens — with a viem `createNonceManager` so parallel sends claim sequential nonces. Returns the
 * three primitives `createPendingQueue` injects: {@link SendTx}, {@link GetReceipt}, {@link GetBaseFee}.
 */
export function createSigner(
  config: Pick<Config, 'chain' | 'rpcUrl' | 'rpcUrlFallback' | 'liquidatorPrivateKey'>
): Signer {
  const rpc = (url: string) => http(url, { timeout: RPC_TIMEOUT_MS })
  // viem-dlc's `failover` transport types its options as `unknown`, which isn't assignable to viem's
  // `Transport` (Record options) — the cast is safe (it's a valid runtime transport). The deployless
  // read client sidesteps this by re-wrapping `failover` in `deployless`.
  const transport = (
    config.rpcUrlFallback
      ? failover([rpc(config.rpcUrl), rpc(config.rpcUrlFallback)])
      : rpc(config.rpcUrl)
  ) as Transport
  const account = privateKeyToAccount(config.liquidatorPrivateKey, {
    nonceManager: createNonceManager({ source: jsonRpc() })
  })
  const client = createWalletClient({ account, chain: config.chain, transport })

  // First send: omit `nonce` and pass the account's nonceManager so prepare claims the next nonce
  // (it must be passed explicitly — the action does not read it off the account). Replacement: the
  // queue passes an explicit `nonce`, which bypasses the manager.
  const send: SendTx = async req => {
    const request = await prepareTransactionRequest(client, {
      account,
      to: req.to,
      data: req.data,
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas,
      ...(req.nonce === undefined ? { nonceManager: account.nonceManager } : { nonce: req.nonce })
    })
    // `request.nonce` is dropped from the returned object when it is 0 (truthiness), so fall back.
    const nonce = request.nonce ?? req.nonce ?? 0
    const txHash = await sendTransaction(client, request)
    return { nonce, txHash }
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

  return { account, send, getReceipt, getBaseFee }
}
