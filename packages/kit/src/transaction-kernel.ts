import type { KernelConfig, KernelHostOptions, Validator } from '@repo/kernel'
import type { Address, Chain, Client, Hex, LocalAccount } from 'viem'

import { createLedgerStore } from '@repo/kernel'
import { join } from 'node:path'
import { BaseError } from 'viem'

import type { Finality } from './kernel-chain'
import type { BotLogger } from './logger'

import { FeeLimitError, NoCommitmentsError } from './errors'
import { createKernelChain } from './kernel-chain'
import { createKernelEffects } from './kernel-effects'
import { DEFAULT_MAX_DATA_BYTES } from './policy'
import { createAccountSigner } from './signer'

/**
 * How many native reservations the kernel's cap allows: one per nonce until its transaction
 * resolves, and one per act not yet at a nonce, each the per-transaction spend ceiling.
 */
export const TRANSACTION_KERNEL_RESERVATIONS = 4
const POLL_MS = 1_000
const REORG_DEPTH = 64
const MAX_SIM_LAG_BLOCKS = 3
const LATCH_BOUND_BLOCKS = 100
const RECOVERY_BOUND_MS = 15 * 60_000
const MAX_RECOVERY_ATTEMPTS = 3
const MAX_DISPATCH_LAG_MS = 10_000
/** Nothing a transaction-only bot signs creates a commitment, so nothing is ever stale-revoked. */
const REVOKE_AFTER_STALE_MS = 60 * 60_000
/** How many signed transactions' fees are remembered for their `tx.sent` line. */
const REMEMBERED_FEES = 256
const URL = /\b[a-z][a-z\d+.-]*:\/\/\S+/giu

/** A kernel log reason that cannot copy an arbitrary error message or credentialed URL. */
const kernelErrorReason = (error: unknown): string =>
  error instanceof FeeLimitError
    ? error.message
    : error instanceof BaseError
      ? error.shortMessage.replace(URL, '[redacted URL]')
      : error instanceof Error
        ? error.name
        : 'UnknownError'

/** What one signed transaction bids, per gas unit. */
export type SignedFees = Readonly<{ maxFeePerGasWei: bigint; priorityFeePerGasWei: bigint }>

export type TransactionKernelLimits = Readonly<{
  chainId: number
  targets: readonly Address[]
  /** The one outer selector the signer may call on `targets`. */
  selector: Hex
  maxFeePerGasWei: bigint
  maxSpendWei: bigint
  maxGasLimit: bigint
  priorityFeePerGasWei: bigint
  /** Blocks without inclusion before the kernel replaces a candidate. */
  stuckBlocks: number
  /** How far below head a fact may have been read: see `KernelConfig.maxEvidenceAgeBlocks`. */
  maxEvidenceAgeBlocks: number
}>

/** A live kernel's options; the bot adds its graph's facts, requests and listeners. */
export type TransactionKernelOptions = Omit<
  KernelHostOptions,
  'id' | 'requests' | 'facts' | 'onActivity'
>

/**
 * The kernel's configuration for an account that only calls `targets`, and only in ways `validator`
 * reads as creating no commitment.
 */
export const transactionKernelConfig = (
  limits: Pick<
    TransactionKernelLimits,
    'chainId' | 'targets' | 'maxSpendWei' | 'stuckBlocks' | 'maxEvidenceAgeBlocks'
  >,
  account: Address,
  validator: Validator
): KernelConfig => ({
  chainId: limits.chainId,
  account,
  validators: [validator],
  policy: { targets: [...limits.targets], recoveryTargets: [] },
  caps: { native: BigInt(TRANSACTION_KERNEL_RESERVATIONS) * limits.maxSpendWei },
  observedResources: [],
  feeReserve: limits.maxSpendWei,
  feePolicy: () => limits.maxSpendWei,
  maxSimLagBlocks: MAX_SIM_LAG_BLOCKS,
  maxEvidenceAgeBlocks: limits.maxEvidenceAgeBlocks,
  stuckBlocks: limits.stuckBlocks,
  latchBoundBlocks: LATCH_BOUND_BLOCKS,
  recoveryBoundMs: RECOVERY_BOUND_MS,
  revokeAfterStaleMs: REVOKE_AFTER_STALE_MS,
  maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
  maxDispatchLagMs: MAX_DISPATCH_LAG_MS
})

/**
 * The live kernel for a transaction-only bot's account: its ledger under `stateDirectory`, chain
 * reads and effects over viem, and every transaction it signs also checked by the signer's policy,
 * which pins `targets` and `selector`.
 */
export const transactionKernelSpec = (parameters: {
  limits: TransactionKernelLimits
  validator: Validator
  account: LocalAccount
  chain: Chain
  client: Client
  rpcUrl: string
  rpcUrlFallback?: string | undefined
  stateDirectory: string
  enrollment: 'enrolled' | 'enrolling'
  effectTimeoutMs: number
  finality: Finality
  logger: BotLogger
}): Readonly<{
  live: TransactionKernelOptions
  /** The fees a transaction this kernel signed bids, while it is among the last few signed. */
  feesOf: (hash: string) => SignedFees | undefined
}> => {
  const { limits, account, client, logger } = parameters
  const fees = new Map<string, SignedFees>()
  const policySigner = createAccountSigner({
    account,
    chain: parameters.chain,
    rpcUrl: parameters.rpcUrl,
    rpcUrlFallback: parameters.rpcUrlFallback,
    policy: {
      chainId: limits.chainId,
      targets: [...limits.targets],
      selector: limits.selector,
      maxFeePerGasWei: limits.maxFeePerGasWei,
      maxSpendWei: limits.maxSpendWei,
      maxGasLimit: limits.maxGasLimit,
      maxDataBytes: DEFAULT_MAX_DATA_BYTES
    },
    logger
  })
  const signer: typeof policySigner = {
    ...policySigner,
    sign: async request => {
      const signed = await policySigner.sign(request)
      fees.set(signed.txHash, {
        maxFeePerGasWei: request.maxFeePerGas,
        priorityFeePerGasWei: request.maxPriorityFeePerGas
      })
      for (const hash of fees.keys()) if (fees.size > REMEMBERED_FEES) fees.delete(hash)
      return signed
    }
  }
  const live: TransactionKernelOptions = {
    config: transactionKernelConfig(limits, account.address, parameters.validator),
    store: createLedgerStore(
      join(
        parameters.stateDirectory,
        `kernel-${limits.chainId}-${account.address.toLowerCase()}.json`
      )
    ),
    chain: createKernelChain({
      client,
      account: account.address,
      finality: parameters.finality,
      commitment: () => Promise.reject(new NoCommitmentsError([]))
    }),
    effects: createKernelEffects({
      client,
      signer,
      maxFeePerGasWei: limits.maxFeePerGasWei,
      priorityFeePerGasWei: limits.priorityFeePerGasWei,
      maxGasLimit: limits.maxGasLimit,
      materialize: () => Promise.reject(new NoCommitmentsError([]))
    }),
    enrollment: parameters.enrollment,
    pollMs: POLL_MS,
    effectTimeoutMs: parameters.effectTimeoutMs,
    reorgDepth: REORG_DEPTH,
    onError: (source, error) =>
      logger.warn('kernel.error', {
        source,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        reason: kernelErrorReason(error)
      })
  }
  return { live, feesOf: hash => fees.get(hash) }
}
