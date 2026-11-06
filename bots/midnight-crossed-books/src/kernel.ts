import type { BotLogger } from '@repo/kit'
import type { AbiFunction, LocalAccount } from 'viem'

import { CrossedBooksResolver } from '@repo/contracts'
import { blocksFor, createHttpTransport, transactionKernelSpec } from '@repo/kit'
import { crossedBooksValidator } from '@repo/validators'
import { createPublicClient, getAbiItem, toFunctionSelector } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { Config, WriteConfig } from './config'

import { PREPARE_TIMEOUT_MS } from './graph'

const KERNEL_EFFECT_TIMEOUT_MS = 10_000
/** How long a sent transaction may wait for inclusion before the kernel replaces it at a higher fee. */
const STUCK_MS = 8_000
const MIN_EVIDENCE_AGE_BLOCKS = 256

const RESOLVE_SELECTOR = toFunctionSelector(
  getAbiItem({ abi: CrossedBooksResolver.abi, name: 'resolve' }) as AbiFunction
)

/** Deliberately twice what one act rests on: a scan's validity plus its preparation. */
const maxEvidenceAgeBlocks = (config: Pick<Config, 'worldValidMs' | 'chain'>) =>
  blocksFor(2 * (config.worldValidMs + PREPARE_TIMEOUT_MS), config.chain, MIN_EVIDENCE_AGE_BLOCKS)

/** The EOA that sends resolutions and receives their profit. Only the kernel signs with it. */
export const resolverAccount = (mode: WriteConfig) => privateKeyToAccount(mode.privateKey)

/** The live kernel for the resolver's account: `resolve` on the resolver only, each read by its validator. */
export const resolverKernel = (options: {
  config: Config
  mode: WriteConfig
  account: LocalAccount
  logger: BotLogger
}) => {
  const { config, mode, account, logger } = options
  return transactionKernelSpec({
    limits: {
      chainId: config.chainId,
      targets: [config.resolver],
      selector: RESOLVE_SELECTOR,
      maxFeePerGasWei: mode.maxFeePerGasWei,
      maxSpendWei: mode.maxSpendWei,
      maxGasLimit: mode.maxGasLimit,
      stuckMs: STUCK_MS,
      maxEvidenceAgeBlocks: maxEvidenceAgeBlocks(config)
    },
    validator: crossedBooksValidator({ resolver: config.resolver, midnight: config.midnight }),
    account,
    chain: config.chain,
    client: createPublicClient({
      chain: config.chain,
      transport: createHttpTransport(config.rpcUrl, config.rpcUrlFallback)
    }),
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback,
    stateDirectory: mode.kernel.stateDirectory,
    enrollment: mode.kernel.enrollment,
    effectTimeoutMs: KERNEL_EFFECT_TIMEOUT_MS,
    finality: mode.finality,
    logger
  })
}
