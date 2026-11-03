import type { BotLogger } from '@repo/kit'
import type { LocalAccount } from 'viem'

import {
  blocksFor,
  createHttpTransport,
  DEFAULT_MAX_GAS_LIMIT,
  EXECUTOR_SELECTOR,
  transactionKernelSpec
} from '@repo/kit'
import { executorLiquidationValidator } from '@repo/validators'
import { createPublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { Config } from './config'

const KERNEL_EFFECT_TIMEOUT_MS = 10_000
/** How long a sent transaction may wait for inclusion before the kernel replaces it at a higher fee. */
const STUCK_MS = 8_000
/** Deliberately twice what one act rests on: a 30s world read plus a 4s preparation, 2 × 34s. */
const MAX_EVIDENCE_AGE_MS = 68_000
/** The evidence age's floor, which binds on Base's slower blocks. */
const MIN_EVIDENCE_AGE_BLOCKS = 256

/**
 * The EOA that liquidates and receives the end-of-exec sweeps. Only the kernel signs with it,
 * through the bot-kit signer's default-deny policy.
 */
export const liquidatorAccount = (config: Config) =>
  privateKeyToAccount(config.liquidatorPrivateKey)

/** The live kernel for the liquidator's account: Executor calls only, each checked as a liquidation. */
export const liquidatorKernel = (options: {
  config: Config
  account: LocalAccount
  logger: BotLogger
}) => {
  const { config, account, logger } = options
  const maxSpendWei = config.maxFeePerGasWei * DEFAULT_MAX_GAS_LIMIT
  return transactionKernelSpec({
    limits: {
      chainId: config.chainId,
      targets: [config.executooorAddress],
      selector: EXECUTOR_SELECTOR,
      maxFeePerGasWei: config.maxFeePerGasWei,
      maxSpendWei,
      maxGasLimit: DEFAULT_MAX_GAS_LIMIT,
      stuckMs: STUCK_MS,
      maxEvidenceAgeBlocks: blocksFor(MAX_EVIDENCE_AGE_MS, config.chain, MIN_EVIDENCE_AGE_BLOCKS)
    },
    validator: executorLiquidationValidator({
      executor: config.executooorAddress,
      protocol: { kind: 'blue', morpho: config.morpho }
    }),
    account,
    chain: config.chain,
    client: createPublicClient({
      chain: config.chain,
      transport: createHttpTransport(config.rpcUrl, config.rpcUrlFallback)
    }),
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback,
    stateDirectory: config.kernel.stateDirectory,
    enrollment: config.kernel.enrollment,
    effectTimeoutMs: KERNEL_EFFECT_TIMEOUT_MS,
    finality: config.finality,
    logger
  })
}
