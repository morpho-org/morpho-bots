import type { Account, Address, Chain, Hex, LocalAccount, Transport } from 'viem'

import { createWalletClient, isAddressEqual, keccak256, RpcError } from 'viem'
import { getBlock, prepareTransactionRequest, sendRawTransaction } from 'viem/actions'

import type { Logger } from './logger'
import type { Policy } from './policy'

import { PolicyViolationError, PreparedTransactionError, SignWithdrawnError } from './errors'
import { evaluatePolicy } from './policy'
import { createHttpTransport } from './transport'

const TRANSACTION_ALREADY_KNOWN = /already known|transaction already imported/i

/**
 * Prepares, policy-checks, and signs at an explicit nonce without broadcasting, so a caller can make
 * the signed bytes durable before they leave the process. A policy violation or a `mayAct()` refusal
 * throws before signing.
 */
type SignTx = (request: {
  to: Address
  data: Hex
  value: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  nonce: number
  /** A gas limit the caller already estimated; omitted, the node estimates one. */
  gas?: bigint
  /** Asked after preparation and the policy check, immediately before the account signs. */
  mayAct: () => boolean
}) => Promise<{ nonce: number; txHash: Hex; raw: Hex; gas: bigint }>

/**
 * Sends signed bytes to the primary endpoint only; anything that may have reached the pool is
 * `broadcastUnknown`, to reconcile by `keccak256(raw)`. A throw means the endpoint rejects the bytes
 * now, not that an earlier send of the same bytes never landed.
 */
type BroadcastRaw = (raw: Hex) => Promise<{ broadcastUnknown?: true }>

/** The signing primitives `createKernelEffects` drives. */
export type Signer = {
  account: Account
  sign: SignTx
  broadcastRaw: BroadcastRaw
  getBaseFee: () => Promise<bigint>
}

/**
 * Builds the policy-checked signing path around a caller-provided local account, which may be
 * non-exportable (AWS KMS). Reads may fail over, but raw transaction submission uses only the
 * primary endpoint so an ambiguous response remains reconcilable. `rpcUrl` must be a full RPC that
 * relays sends: a read-only relay that acknowledges `eth_sendRawTransaction` without forwarding it
 * would sink every transaction.
 */
export function createAccountSigner(options: {
  chain: Chain
  rpcUrl: string
  rpcUrlFallback?: string | undefined
  account: LocalAccount
  /**
   * Default-deny signing policy every prepared transaction is checked against before signing; a
   * violation logs `signer.policy_violation` (error) and throws instead of signing.
   */
  policy: Policy
  /** Where a policy violation is logged before it throws. */
  logger?: Logger | undefined
}): Signer {
  const transport = createHttpTransport(options.rpcUrl, options.rpcUrlFallback)
  const { account } = options
  const client = createWalletClient({ account, chain: options.chain, transport })
  // A raw transaction is sent to exactly one endpoint. Falling through to a second endpoint after
  // a lost response can turn "accepted, response lost" into a definitive-looking "already known"
  // or "nonce too low" rejection, erasing the ambiguity the kernel must reconcile.
  const broadcastClient = options.rpcUrlFallback
    ? createWalletClient({
        account,
        chain: options.chain,
        transport: createHttpTransport(options.rpcUrl) as Transport
      })
    : client

  const sign: SignTx = async req => {
    const request = await prepareTransactionRequest(client, {
      account,
      chainId: options.chain.id,
      to: req.to,
      data: req.data,
      value: req.value,
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas,
      nonce: req.nonce,
      ...(req.gas === undefined ? {} : { gas: req.gas })
    })
    // A node's `eth_fillTransaction` answer can replace a zero or missing fee, or add a gasPrice:
    // https://github.com/wevm/viem/blob/viem%402.47.17/src/actions/public/fillTransaction.ts
    if (request.gas === undefined)
      throw new PreparedTransactionError('the prepared transaction has no gas limit')
    const asRequested =
      request.chainId === options.chain.id &&
      request.nonce === req.nonce &&
      request.to !== null &&
      request.to !== undefined &&
      isAddressEqual(request.to, req.to) &&
      request.data === req.data &&
      request.value === req.value &&
      request.maxFeePerGas === req.maxFeePerGas &&
      request.maxPriorityFeePerGas === req.maxPriorityFeePerGas &&
      !('gasPrice' in request && request.gasPrice !== undefined) &&
      (req.gas === undefined || request.gas === req.gas)
    if (!asRequested)
      throw new PreparedTransactionError('the prepared transaction differs from the one requested')
    const decision = evaluatePolicy(options.policy, {
      chainId: options.chain.id,
      from: account.address,
      to: req.to,
      data: req.data,
      value: req.value,
      gas: request.gas,
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
    if (!req.mayAct()) throw new SignWithdrawnError()
    const raw = await account.signTransaction(request)
    return { nonce: req.nonce, txHash: keccak256(raw), raw, gas: request.gas }
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

  const getBaseFee = async () => {
    const block = await getBlock(client, { blockTag: 'latest' })
    if (block.baseFeePerGas === null) throw new Error('chain returned no baseFeePerGas')
    return block.baseFeePerGas
  }

  return { account, sign, broadcastRaw, getBaseFee }
}
