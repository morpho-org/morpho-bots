import type { KernelEffects } from '@repo/kernel'
import type { Client, Hex, LocalAccount, TypedDataDefinition } from 'viem'

import { bigintMin, mulDivUp } from '@repo/utils'
import { BaseError, getAddress, isAddressEqual, parseTransaction, RpcError } from 'viem'
import { estimateGas } from 'viem/actions'

import type { Signer } from './signer'

import { FeeLimitError, SignWithdrawnError } from './errors'
import { bumpFees, initialFees } from './fee-policy'
import { callAt } from './kernel-chain'
import { NONCE_FILL_MAX_GAS } from './policy'
import { isCallRevert } from './revert.utils'

/** How many nonces back a candidate's fees are kept to price its replacement. */
const REMEMBERED_NONCES = 64
const GAS_HEADROOM_NUMERATOR = 120n
const GAS_HEADROOM_DENOMINATOR = 100n

type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

/**
 * A node's own refusal to pool these bytes, which no earlier send of them can have changed. Error
 * codes cannot say this (`-32000` is also a generic server error), so only geth's txpool admission
 * errors count: https://github.com/ethereum/go-ethereum/blob/master/core/txpool/errors.go
 */
const ADMISSION_REFUSAL =
  /replacement transaction underpriced|transaction underpriced|insufficient funds|max fee per gas less than block base fee|fee cap less than block base fee|intrinsic gas too low|exceeds block gas limit|tip higher than fee cap|max priority fee per gas higher than max fee per gas/i

const refusedAdmission = (error: unknown) =>
  error instanceof BaseError &&
  error.walk(e => e instanceof RpcError && ADMISSION_REFUSAL.test(e.details)) !== null

/**
 * The kernel's effects over a kit {@link Signer}: simulations pinned to the kernel's block,
 * signing through the signer's policy, and broadcasts to its one endpoint. Building a dependent
 * step's payload is the bot's.
 */
export const createKernelEffects = (options: {
  client: Client
  signer: Signer
  /** Signs the kernel's typed data; the account the signer sends from when omitted. */
  typedSigner?: LocalAccount
  /** The bot's policy ceiling on one gas unit, and the tip a first candidate bids. */
  maxFeePerGasWei: bigint
  priorityFeePerGasWei: bigint
  /** The signer's gas-limit ceiling for an ordinary payload. */
  maxGasLimit: bigint
  materialize: KernelEffects['materialize']
}): KernelEffects => {
  const { client, signer } = options
  const from = signer.account.address
  const typedSigner = options.typedSigner ?? (signer.account as LocalAccount)
  const priced = new Map<number, Fees>()

  const remember = (nonce: number, fees: Fees) => {
    priced.set(nonce, fees)
    for (const known of priced.keys()) if (known < nonce - REMEMBERED_NONCES) priced.delete(known)
  }

  /**
   * A first candidate bids {@link initialFees}, and a replacement outbids the candidate it
   * replaces. When that candidate's fees are unknown after a restart, the replacement bids the
   * ceiling in full. A known candidate that cannot be outbid within the ceiling is not replaced.
   */
  const feesFor = async (nonce: number, level: number, ceiling: bigint): Promise<Fees> => {
    const baseFee = await signer.getBaseFee()
    if (level === 1)
      return initialFees(baseFee, ceiling, bigintMin(ceiling, options.priorityFeePerGasWei))
    const previous = priced.get(nonce)
    if (!previous) return { maxFeePerGas: ceiling, maxPriorityFeePerGas: ceiling }
    const bumped = bumpFees({ ...previous, baseFee, maxFeePerGasWei: ceiling })
    if (bumped.kind === 'drop')
      throw new FeeLimitError(
        'replacement cannot outbid the known candidate within its fee ceiling'
      )
    return bumped.fees
  }

  return {
    materialize: options.materialize,
    simulate: async (payload, at, signal) => {
      signal.throwIfAborted()
      try {
        await callAt(client, at, {
          from,
          to: getAddress(payload.to),
          data: payload.data as Hex,
          value: payload.value
        })
        return true
      } catch (error) {
        if (isCallRevert(error)) return false
        throw error
      }
    },
    signTx: async (payload, { nonce, fee, level }, guard) => {
      if (payload.value !== 0n) throw new Error('the kernel signer sends no value')
      const request = {
        to: getAddress(payload.to),
        data: payload.data as Hex,
        value: payload.value
      }
      const estimatedGas = await estimateGas(client, { account: from, ...request })
      guard.signal.throwIfAborted()
      const ceiling = bigintMin(options.maxFeePerGasWei, fee / estimatedGas)
      if (ceiling === 0n)
        throw new FeeLimitError('the fee ceiling cannot fund a positive per-gas bid')
      const fees = await feesFor(nonce, level, ceiling)
      const paddedGas = mulDivUp(estimatedGas, GAS_HEADROOM_NUMERATOR, GAS_HEADROOM_DENOMINATOR)
      const policyGasLimit = isAddressEqual(request.to, from)
        ? NONCE_FILL_MAX_GAS
        : options.maxGasLimit
      const policyCappedGas =
        estimatedGas < policyGasLimit ? bigintMin(paddedGas, policyGasLimit) : estimatedGas
      const gas = bigintMin(policyCappedGas, fee / fees.maxFeePerGas)
      if (gas < estimatedGas)
        throw new FeeLimitError('the fee ceiling cannot fund the estimated gas')
      const mayAct = () => guard.mayAct()
      const { txHash, raw } = await signer.sign({ ...request, ...fees, nonce, gas, mayAct })
      return { hash: txHash, raw }
    },
    signTyped: async (payload, guard) => {
      if (!guard.mayAct()) throw new SignWithdrawnError()
      return typedSigner.signTypedData(payload as unknown as TypedDataDefinition)
    },
    broadcast: async (raw, guard) => {
      if (!guard.mayAct()) throw new Error('the dispatch was withdrawn before sending')
      try {
        const transaction = parseTransaction(raw as Hex)
        if (
          transaction.type !== 'eip1559' ||
          transaction.nonce === undefined ||
          transaction.maxFeePerGas === undefined ||
          transaction.maxPriorityFeePerGas === undefined
        )
          throw new Error('the kernel signer produced a transaction without EIP-1559 fees')
        const broadcast = signer.broadcastRaw(raw as Hex)
        remember(transaction.nonce, {
          maxFeePerGas: transaction.maxFeePerGas,
          maxPriorityFeePerGas: transaction.maxPriorityFeePerGas
        })
        const { broadcastUnknown } = await broadcast
        return broadcastUnknown ? 'unknown' : 'accepted'
      } catch (error) {
        return refusedAdmission(error) ? 'rejected' : 'unknown'
      }
    },
    release: () => Promise.reject(new Error('this bot releases nothing offchain'))
  }
}
