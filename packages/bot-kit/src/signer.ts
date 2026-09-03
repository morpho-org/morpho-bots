import type { Account, Chain, Hex, Transport } from 'viem'

import { tryCatch } from '@repo/utils'
import { createWalletClient, TransactionReceiptNotFoundError } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  getBalance,
  getBlock,
  getTransactionCount,
  getTransactionReceipt,
  prepareTransactionRequest,
  sendTransaction
} from 'viem/actions'

import type { Logger } from './logger'
import type { Policy } from './policy'
import type {
  GetBaseFee,
  GetConsumedNonce,
  GetReceipt,
  SendTx,
  SyncNonce
} from './queue/pending-queue'

import { evaluatePolicy, PolicyViolationError } from './policy'
import { createHttpTransport } from './transport'
import { TxSendError } from './tx-send.error'

/** The signed-send primitives {@link createSigner} returns and `createPendingQueue` injects. */
export type Signer = {
  account: Account
  send: SendTx
  getReceipt: GetReceipt
  getBaseFee: GetBaseFee
  syncNonce: SyncNonce
  /** Latest (mined) transaction count for the EOA — the pending queue's nonce-consumed reconciler. */
  consumedNonce: GetConsumedNonce
  /** The EOA's native balance (wei) — feeds the periodic `signer.balance` metric. */
  balance: () => Promise<bigint>
}

/**
 * Builds the signed-send path the pending queue needs: a plain HTTP (optionally `failover`) wallet
 * client — deliberately NOT the viem-dlc `deployless` transport, which only wraps `eth_call` for the
 * lens — with a local pending-nonce cursor so sequential sends claim sequential nonces. `rpcUrl`
 * must be a full RPC that relays sends: a read-only relay that acks `eth_sendRawTransaction`
 * without forwarding it to the sequencer would sink every tx. Returns the primitives
 * `createPendingQueue` injects: {@link SendTx}, {@link GetReceipt}, {@link GetBaseFee}, {@link SyncNonce}.
 */
export function createSigner(options: {
  chain: Chain
  rpcUrl: string
  rpcUrlFallback?: string | undefined
  privateKey: Hex
  /**
   * Default-deny signing policy. When set, every prepared transaction is checked against it between
   * prepare and broadcast; a violation logs `signer.policy_violation` (error) and throws instead of
   * sending. Bots pass their authorized target(s) + ceilings here; omitted only in generic/unit
   * contexts.
   */
  policy?: Policy | undefined
  /** Where a policy violation is logged before it throws. */
  logger?: Logger | undefined
}): Signer {
  // viem-dlc's `failover` transport types its options as `unknown`, which isn't assignable to viem's
  // `Transport` (Record options) — the cast is safe (it's a valid runtime transport). The deployless
  // read client sidesteps this by re-wrapping the base transport in `deployless`.
  const transport = createHttpTransport(options.rpcUrl, options.rpcUrlFallback) as Transport
  const account = privateKeyToAccount(options.privateKey)
  const client = createWalletClient({ account, chain: options.chain, transport })
  let nextNonce: number | undefined
  // In-flight first read of the cursor, shared by every concurrent first-send (cleared once settled).
  let cursorRead: Promise<number> | undefined

  const readPendingNonce = (): Promise<number> =>
    getTransactionCount(client, { address: account.address, blockTag: 'pending' })

  // Reclaim a runaway cursor: a tx that was broadcast but never mined (then dropped from our tracked
  // set) leaves the cursor above chain truth, so every later send is an unminable future nonce. The
  // queue calls this when nothing is in flight, collapsing the cursor back to the chain's pending
  // nonce. With txs genuinely in flight the cursor must stay ahead, so the queue only syncs on empty.
  const syncNonce: SyncNonce = async () => {
    nextNonce = await readPendingNonce()
  }

  // Defense in depth behind the pending queue's serialized submit: `nextNonce ??= await read()`
  // null-checks BEFORE the await, so two concurrent first-sends would each read and each claim the
  // same nonce. Memoizing the in-flight read makes them share one round trip, and the post-await
  // `??=` keeps the loser from overwriting a cursor the winner already advanced.
  const claimNonce = async (): Promise<number> => {
    if (nextNonce === undefined) {
      cursorRead ??= readPendingNonce().finally(() => {
        cursorRead = undefined
      })
      const read = await cursorRead
      nextNonce ??= read
    }
    const nonce = nextNonce
    nextNonce = nonce + 1
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
    // Default-deny guard between prepare and broadcast: a violation means an upstream encoding bug,
    // so fail loudly and never send. Roll the cursor back (nothing was broadcast) so the claimed
    // nonce isn't stranded. In-process there is no remote signer to distrust, so the recovered-sender
    // and prepared-vs-signed field checks the daemon-era client did are redundant and skipped.
    if (options.policy) {
      const decision = evaluatePolicy(options.policy, {
        chainId: options.chain.id,
        to: req.to,
        data: req.data,
        value: request.value ?? 0n,
        gas: request.gas ?? 0n,
        maxFeePerGas: req.maxFeePerGas
      })
      if (!decision.ok) {
        if (req.nonce === undefined) nextNonce = Math.min(nextNonce ?? nonce, nonce)
        options.logger?.error('signer.policy_violation', {
          check: decision.check,
          reason: decision.message,
          to: req.to,
          nonce
        })
        throw new PolicyViolationError(decision.message, decision.check)
      }
    }
    try {
      const txHash = await sendTransaction(client, request)
      return { nonce, txHash, gas: request.gas ?? 0n }
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

  // Latest (mined) count — distinct from the local `pending` cursor. The queue's reconciler compares
  // it against tracked nonces to evict txs whose nonce was consumed on-chain without a receipt for us.
  const consumedNonce: GetConsumedNonce = () =>
    getTransactionCount(client, { address: account.address, blockTag: 'latest' })

  const balance = (): Promise<bigint> => getBalance(client, { address: account.address })

  return { account, send, getReceipt, getBaseFee, syncNonce, consumedNonce, balance }
}
