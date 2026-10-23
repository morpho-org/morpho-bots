import type { BotLogger } from '@repo/kit'
import type { LocalAccount } from 'viem'

import { metaMorphoAbi } from '@morpho-org/blue-sdk-viem'
import { createHttpTransport, DEFAULT_MAX_GAS_LIMIT, transactionKernelSpec } from '@repo/kit'
import { vaultV1ReallocationValidator } from '@repo/validators'
import { createPublicClient, getAbiItem, parseGwei, toFunctionSelector } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { Config } from './config'

import { readValidMs } from './config'

const KERNEL_EFFECT_TIMEOUT_MS = 10_000
/** The tip a first send bids. */
const FIRST_SEND_TIP_WEI = parseGwei('1')
/** Blocks a sent transaction may wait for inclusion before the kernel replaces it at a higher fee. */
const STUCK_BLOCKS = 4
/** Base's block time, the fastest of the chains the bot supports. */
const FASTEST_BLOCK_MS = 2_000
const REALLOCATE_SELECTOR = toFunctionSelector(
  getAbiItem({ abi: metaMorphoAbi, name: 'reallocate' })
)

/** Twice the blocks a vault read holds on the fastest chain, which also covers its preparation. */
const evidenceAgeBlocks = (intervalMs: number) =>
  2 * Math.ceil(readValidMs(intervalMs) / FASTEST_BLOCK_MS)

/** The reallocator's EOA. Only the kernel signs with it */
export const reallocatorAccount = (config: Config) =>
  privateKeyToAccount(config.reallocatorPrivateKey)

/** The live kernel for the reallocator's account: `reallocate` on the whitelisted vaults only. */
export const reallocatorKernel = (options: {
  config: Config
  account: LocalAccount
  logger: BotLogger
}) => {
  const { config, account, logger } = options
  const maxSpendWei = config.maxFeePerGasWei * DEFAULT_MAX_GAS_LIMIT
  return transactionKernelSpec({
    limits: {
      chainId: config.chainId,
      targets: config.vaultWhitelist,
      selector: REALLOCATE_SELECTOR,
      maxFeePerGasWei: config.maxFeePerGasWei,
      maxSpendWei,
      maxGasLimit: DEFAULT_MAX_GAS_LIMIT,
      priorityFeePerGasWei: FIRST_SEND_TIP_WEI,
      stuckBlocks: STUCK_BLOCKS,
      maxEvidenceAgeBlocks: evidenceAgeBlocks(config.reallocationIntervalMs)
    },
    validator: vaultV1ReallocationValidator({ vaults: config.vaultWhitelist }),
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
