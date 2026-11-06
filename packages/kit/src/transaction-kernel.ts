import type { KernelConfig, KernelHostOptions, Validator } from '@repo/kernel'
import type { Address, Chain, Client, Hex, LocalAccount } from 'viem'

import { createLedgerStore } from '@repo/kernel'
import { join } from 'node:path'
import { BaseError } from 'viem'

import type { Finality } from './kernel-chain'
import type { BotLogger } from './logger'

import { blocksFor } from './block-time'
import { FeeLimitError, FinalityBeyondWindowError, NoCommitmentsError } from './errors'
import { createKernelChain } from './kernel-chain'
import { createKernelEffects } from './kernel-effects'
import { DEFAULT_MAX_DATA_BYTES } from './policy'
import { redactUrls } from './revert.utils'
import { createAccountSigner } from './signer'

/**
 * How many native reservations the kernel's cap allows: one per nonce until its transaction
 * resolves, and one per act not yet at a nonce, each the per-transaction spend ceiling.
 */
export const TRANSACTION_KERNEL_RESERVATIONS = 4
const POLL_MS = 2_000
/**
 * How far below the head blocks are retained; finality must lag less, or the kernel refuses to
 * start. Base's `safe` block lags 5 minutes while its batcher stalls.
 */
const REORG_WINDOW_MS = 10 * 60_000
/** Mainnet's `finalized` block lags 64 to 95 blocks, so a 12s chain still keeps it inside. */
const MIN_REORG_DEPTH_BLOCKS = 128

/** How many blocks below the head a kernel bot on `chain` retains. */
export const reorgDepthFor = (chain: Pick<Chain, 'id'>) =>
  blocksFor(REORG_WINDOW_MS, chain, MIN_REORG_DEPTH_BLOCKS)
/** How old a simulation may be at the head, though never under 3 blocks on a slow chain. */
const MAX_SIM_LAG_MS = 6_000
const MIN_SIM_LAG_BLOCKS = 3
/** How long a nonce may stay uncertain before the kernel recovers, converted to each chain's blocks. */
const LATCH_BOUND_MS = 200_000
const RECOVERY_BOUND_MS = 15 * 60_000
const MAX_RECOVERY_ATTEMPTS = 3
const MAX_DISPATCH_LAG_MS = 10_000
/** Nothing a transaction-only bot signs creates a commitment, so nothing is ever stale-revoked. */
const REVOKE_AFTER_STALE_MS = 60 * 60_000

/** A kernel log reason that cannot copy an arbitrary error message or credentialed URL. */
const kernelErrorReason = (error: unknown): string =>
  error instanceof FeeLimitError
    ? error.message
    : error instanceof BaseError
      ? redactUrls(error.shortMessage)
      : error instanceof Error
        ? error.name
        : 'UnknownError'

export type TransactionKernelLimits = Readonly<{
  chainId: number
  targets: readonly Address[]
  /** The one outer selector the signer may call on `targets`. */
  selector: Hex
  maxFeePerGasWei: bigint
  maxSpendWei: bigint
  maxGasLimit: bigint
  /** How long a transaction may wait for inclusion before its nonce is stuck; see {@link blocksFor}. */
  stuckMs: number
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
    'chainId' | 'targets' | 'maxSpendWei' | 'stuckMs' | 'maxEvidenceAgeBlocks'
  >,
  chain: Pick<Chain, 'id'>,
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
  maxSimLagBlocks: blocksFor(MAX_SIM_LAG_MS, chain, MIN_SIM_LAG_BLOCKS),
  maxEvidenceAgeBlocks: limits.maxEvidenceAgeBlocks,
  stuckBlocks: blocksFor(limits.stuckMs, chain),
  latchBoundBlocks: blocksFor(LATCH_BOUND_MS, chain),
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
}): Readonly<{ live: TransactionKernelOptions }> => {
  const { limits, account, client, logger } = parameters
  const reorgDepth = reorgDepthFor(parameters.chain)
  const { finality } = parameters
  if (typeof finality === 'object' && finality.depth >= reorgDepth)
    throw new FinalityBeyondWindowError(limits.chainId, finality.depth, reorgDepth)
  const signer = createAccountSigner({
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
  const live: TransactionKernelOptions = {
    config: transactionKernelConfig(
      limits,
      parameters.chain,
      account.address,
      parameters.validator
    ),
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
      maxGasLimit: limits.maxGasLimit,
      materialize: () => Promise.reject(new NoCommitmentsError([])),
      logger
    }),
    enrollment: parameters.enrollment,
    pollMs: POLL_MS,
    effectTimeoutMs: parameters.effectTimeoutMs,
    reorgDepth,
    onError: (source, error) =>
      logger.warn('kernel.error', {
        source,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        reason: kernelErrorReason(error)
      })
  }
  return { live }
}
