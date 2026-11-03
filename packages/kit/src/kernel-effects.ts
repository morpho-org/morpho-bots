import type { KernelEffects } from '@repo/kernel'
import type { Client, Hex, LocalAccount, TypedDataDefinition } from 'viem'

import { bigintMin, mulDivUp } from '@repo/utils'
import { BaseError, getAddress, isAddressEqual, RpcError } from 'viem'
import { estimateGas } from 'viem/actions'

import type { Signer } from './signer'

import { FeeLimitError, SignWithdrawnError } from './errors'
import { bumpFees, feeCeiling, initialFees, stepCap } from './fee-policy'
import { callAt } from './kernel-chain'
import { NONCE_FILL_MAX_GAS } from './policy'
import { isCallRevert } from './revert.utils'
import { isAlreadyKnown } from './signer'

const GAS_HEADROOM_NUMERATOR = 120n
const GAS_HEADROOM_DENOMINATOR = 100n

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
 * The kernel's effects over a kit {@link Signer}. A bid stays within its spend bound and under
 * {@link feeCeiling}, a step's under {@link stepCap}; a replacement bumps `outbid` or is `capped`.
 */
export const createKernelEffects = (options: {
  client: Client
  signer: Signer
  /** Signs the kernel's typed data; the account the signer sends from when omitted. */
  typedSigner?: LocalAccount
  /** The bot's policy ceiling on one gas unit. */
  maxFeePerGasWei: bigint
  /** The signer's gas-limit ceiling for an ordinary payload. */
  maxGasLimit: bigint
  materialize: KernelEffects['materialize']
}): KernelEffects => {
  const { client, signer } = options
  const from = signer.account.address
  const typedSigner = options.typedSigner ?? (signer.account as LocalAccount)

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
    signTx: async (payload, { nonce, kind, fee, recoveryFee, outbid }, guard) => {
      if (payload.value !== 0n) throw new Error('the kernel signer sends no value')
      const request = {
        to: getAddress(payload.to),
        data: payload.data as Hex,
        value: payload.value
      }
      const estimatedGas = await estimateGas(client, { account: from, ...request })
      guard.signal.throwIfAborted()
      const ceiling = feeCeiling(options.maxFeePerGasWei, recoveryFee)
      const perGas = bigintMin(kind === 'step' ? stepCap(ceiling) : ceiling, fee / estimatedGas)
      const baseFee = await signer.getBaseFee()
      let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
      if (outbid) {
        const bumped = bumpFees({ ...outbid, baseFee, maxFeePerGasWei: perGas })
        if (bumped.kind === 'drop') return 'capped'
        fees = bumped.fees
      } else {
        if (perGas <= 0n)
          throw new FeeLimitError('the fee ceiling cannot fund a positive per-gas bid')
        fees = initialFees(baseFee, perGas)
      }
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
      return { hash: txHash, raw, bid: { ...fees, gas } }
    },
    signTyped: async (payload, guard) => {
      if (!guard.mayAct()) throw new SignWithdrawnError()
      return typedSigner.signTypedData(payload as unknown as TypedDataDefinition)
    },
    broadcast: async (raw, guard) => {
      if (!guard.mayAct()) throw new Error('the dispatch was withdrawn before sending')
      try {
        const { broadcastUnknown } = await signer.broadcastRaw(raw as Hex)
        return broadcastUnknown ? 'unknown' : 'accepted'
      } catch (error) {
        if (isAlreadyKnown(error)) return 'accepted'
        return refusedAdmission(error) ? 'rejected' : 'unknown'
      }
    },
    release: () => Promise.reject(new Error('this bot releases nothing offchain'))
  }
}
