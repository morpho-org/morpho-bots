import type { BotLogger } from '@repo/kit'
import type { Address, Client, LocalAccount } from 'viem'

import {
  blocksFor,
  createHttpTransport,
  EXECUTOR_SELECTOR,
  feeCeiling,
  firstBid,
  gasLimitFor,
  stepCap,
  transactionKernelSpec
} from '@repo/kit'
import { bigintMin } from '@repo/utils'
import { executorLiquidationValidator } from '@repo/validators'
import { createPublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { estimateGas, getBlock } from 'viem/actions'
import { estimateL1Fee } from 'viem/op-stack'

import type { Config } from './config'
import type { PrepareDeps } from './prepare'

import { STUCK_MS } from './config'
import { MissingBaseFeeError } from './errors'
import { PREPARE_TIMEOUT_MS } from './graph'

const KERNEL_EFFECT_TIMEOUT_MS = 10_000
/** The evidence age's floor in blocks. */
const MIN_EVIDENCE_AGE_BLOCKS = 64

/** Deliberately twice what one act rests on: a world read's validity plus its preparation. */
const maxEvidenceAgeBlocks = (config: Pick<Config, 'worldValidMs' | 'chain'>) =>
  blocksFor(2 * (config.worldValidMs + PREPARE_TIMEOUT_MS), config.chain, MIN_EVIDENCE_AGE_BLOCKS)

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
  return transactionKernelSpec({
    limits: {
      chainId: config.chainId,
      targets: [config.executooorAddress],
      selector: EXECUTOR_SELECTOR,
      maxFeePerGasWei: config.maxFeePerGasWei,
      maxSpendWei: config.maxSpendWei,
      maxGasLimit: config.maxGasLimit,
      stuckMs: STUCK_MS,
      maxEvidenceAgeBlocks: maxEvidenceAgeBlocks(config)
    },
    validator: executorLiquidationValidator({
      executor: config.executooorAddress,
      protocol: { kind: 'midnight', midnight: config.midnight }
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

/** {@link PrepareDeps.feesFor} for an Executor call from `account`, as the kernel signs it. */
export const liquidationFees =
  (
    client: Client,
    config: Pick<
      Config,
      'chain' | 'chainId' | 'executooorAddress' | 'maxFeePerGasWei' | 'maxGasLimit' | 'maxSpendWei'
    >,
    account: Address
  ): PrepareDeps['feesFor'] =>
  async data => {
    const call = { account, to: config.executooorAddress, data }
    const [estimatedGas, { baseFeePerGas }, l1Data] = await Promise.all([
      estimateGas(client, call),
      getBlock(client, { blockTag: 'latest' }),
      config.chain.contracts?.gasPriceOracle
        ? estimateL1Fee(client, { ...call, chain: config.chain })
        : 0n
    ])
    if (baseFeePerGas === null) throw new MissingBaseFeeError(config.chainId)
    const gasLimit = gasLimitFor(estimatedGas, config.maxGasLimit)
    const maxFeePerGas = stepCap(feeCeiling(config.maxFeePerGasWei, config.maxSpendWei))
    return {
      l1Data,
      baseFee: baseFeePerGas,
      gasLimit,
      firstBid: fee =>
        firstBid({
          fee: bigintMin(fee, config.maxSpendWei),
          estimatedGas,
          baseFee: baseFeePerGas,
          maxFeePerGas,
          gasLimit
        })
    }
  }
