import type { Account, Chain, Hex, LocalAccount, Transport } from 'viem'

import { tryCatch } from '@repo/utils'
import { createWalletClient, keccak256, RpcError, TransactionReceiptNotFoundError } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  getBalance,
  getBlock,
  getTransactionCount,
  getTransactionReceipt,
  prepareTransactionRequest,
  sendRawTransaction
} from 'viem/actions'

import type { Logger } from './logger'
import type { Policy } from './policy'
import type {
  GetBaseFee,
  GetConsumedNonce,
  GetReceipt,
  SendTx,
  SyncNonce,
  TxRequest
} from './queue/pending-queue'

import { evaluatePolicy, PolicyViolationError } from './policy'
import { createHttpTransport } from './transport'

const TRANSACTION_ALREADY_KNOWN = /already known|transaction already imported/i

/**
 * Prepares, policy-checks, and signs at an explicit nonce without broadcasting, so a caller can make
 * the signed bytes durable before they leave the process. A policy violation throws before signing.
 * The nonce is not claimed: a caller that allocates its own must not share a signer with `send`.
 */
type SignTx = (
  request: TxRequest & { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; nonce: number }
) => Promise<{ nonce: number; txHash: Hex; raw: Hex; gas: bigint }>

/**
 * Sends signed bytes to the primary endpoint only; anything that may have reached the pool is
 * `broadcastUnknown`, to reconcile by `keccak256(raw)`. A throw means the endpoint rejects the bytes
 * now, not that an earlier send of the same bytes never landed.
 */
type BroadcastRaw = (raw: Hex) => Promise<{ broadcastUnknown?: true }>

/** The signed-send primitives {@link createSigner} returns and `createPendingQueue` injects. */
export type Signer = {
  account: Account
  /** {@link Signer.sign} then {@link Signer.broadcastRaw}, claiming a nonce when none is given. */
  send: SendTx
  sign: SignTx
  broadcastRaw: BroadcastRaw
  getReceipt: GetReceipt
  getBaseFee: GetBaseFee
  syncNonce: SyncNonce
  /** Latest (mined) transaction count for the EOA — the pending queue's nonce-consumed reconciler. */
  consumedNonce: GetConsumedNonce
  /** The EOA's native balance (wei) — feeds the periodic `signer.balance` metric. */
  balance: () => Promise<bigint>
}

/**
 * Builds the signed-send path the pending queue needs with a local pending-nonce cursor so
 * sequential sends claim sequential nonces. Reads may fail over, but raw transaction submission
 * uses only the primary endpoint so an ambiguous response remains reconcilable. `rpcUrl` must be a
 * full RPC that relays sends: a read-only relay that acknowledges `eth_sendRawTransaction` without
 * forwarding it would sink every transaction. Returns the primitives `createPendingQueue` injects:
 * {@link SendTx}, {@link GetReceipt}, {@link GetBaseFee}, and {@link SyncNonce}.
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
  return createAccountSigner({
    ...options,
    account: privateKeyToAccount(options.privateKey)
  })
}

/**
 * Builds the shared signed-send path around a caller-provided local account. This supports
 * non-exportable accounts such as AWS KMS while retaining the same nonce, policy, receipt, and
 * balance behavior as {@link createSigner}.
 */
export function createAccountSigner(options: {
  chain: Chain
  rpcUrl: string
  rpcUrlFallback?: string | undefined
  account: LocalAccount
  policy?: Policy | undefined
  logger?: Logger | undefined
}): Signer {
  const transport = createHttpTransport(options.rpcUrl, options.rpcUrlFallback)
  const { account } = options
  const client = createWalletClient({ account, chain: options.chain, transport })
  // A raw transaction is sent to exactly one endpoint. Falling through to a second endpoint after
  // a lost response can turn "accepted, response lost" into a definitive-looking "already known"
  // or "nonce too low" rejection, erasing the ambiguity the pending queue must reconcile.
  const broadcastClient = options.rpcUrlFallback
    ? createWalletClient({
        account,
        chain: options.chain,
        transport: createHttpTransport(options.rpcUrl) as Transport
      })
    : client
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

  const sign: SignTx = async req => {
    const request = await prepareTransactionRequest(client, {
      account,
      to: req.to,
      data: req.data,
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas,
      nonce: req.nonce
    })
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
        options.logger?.error('signer.policy_violation', {
          check: decision.check,
          reason: decision.message,
          to: req.to,
          nonce: req.nonce
        })
        throw new PolicyViolationError(decision.message, decision.check)
      }
    }
    const raw = await account.signTransaction(request)
    return { nonce: req.nonce, txHash: keccak256(raw), raw, gas: request.gas ?? 0n }
  }

  const broadcastRaw: BroadcastRaw = async raw => {
    try {
      const responseHash = await sendRawTransaction(broadcastClient, { serializedTransaction: raw })
      // The signed bytes are authoritative: a mismatched response is as ambiguous as a lost one.
      return responseHash === keccak256(raw) ? {} : { broadcastUnknown: true }
    } catch (error) {
      if (error instanceof RpcError && !TRANSACTION_ALREADY_KNOWN.test(error.details)) throw error
      return { broadcastUnknown: true }
    }
  }

  // A first send claims from the cursor and gives the nonce back if nothing was broadcast; a
  // replacement passes its own nonce, which never moves the cursor.
  const send: SendTx = async req => {
    const nonce = req.nonce ?? (await claimNonce())
    try {
      const { raw, ...signed } = await sign({ ...req, nonce })
      return { ...signed, ...(await broadcastRaw(raw)) }
    } catch (error) {
      if (req.nonce === undefined) nextNonce = Math.min(nextNonce ?? nonce, nonce)
      throw error
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
  // it against tracked nonces to evict txs whose nonce was consumed onchain without a receipt for us.
  const consumedNonce: GetConsumedNonce = () =>
    getTransactionCount(client, { address: account.address, blockTag: 'latest' })

  const balance = (): Promise<bigint> => getBalance(client, { address: account.address })

  return {
    account,
    send,
    sign,
    broadcastRaw,
    getReceipt,
    getBaseFee,
    syncNonce,
    consumedNonce,
    balance
  }
}
