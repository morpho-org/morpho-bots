import type { Address, Hex, LocalAccount } from 'viem'

import { midnightAbi, setterRatifierAbi } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import {
  createAccountSigner,
  createPendingQueue,
  initialFees,
  simulateCall,
  type Logger,
  type Policy,
  type PolicyRule
} from '@repo/bot-kit'
import { setTimeout as wait } from 'node:timers/promises'
import { createPublicClient, getAbiItem, http, isAddressEqual, toFunctionSelector } from 'viem'

import type { ConfigService } from '../../config/config.service'

import { supportedChain } from '../../config/supported-chains.utils'
import { QuoterTransactionError } from './quoter-transaction.error'

/** Write operations with distinct target, selector, gas, and calldata policy. */
export type QuoterTransactionOperation = 'publish' | 'cancel' | 'cancel-batch' | 'ratify'

/** Invocation-scoped owner of the signer nonce and pending transaction queue. */
export type QuoterTransactionExecutor = {
  readonly signer: Address
  /** Rejects startup while the signer has a nonce this process cannot reconcile. */
  assertNoPendingNonce(): Promise<void>
  /**
   * Simulates, policy-checks, signs, broadcasts, replaces, and reconciles one canonical write.
   * @param parameters - Exact transaction, policy operation, diagnostic label, and optional observer.
   * @returns The tracked hash that confirmed successfully, including a superseded earlier hash.
   */
  execute(parameters: {
    transaction: { to: Address; data: Hex; value: bigint }
    operation: QuoterTransactionOperation
    label: string
    onTransactionSubmitted?: (hash: Hex) => void | Promise<void>
  }): Promise<Hex>
}

const quietLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}

const maximum = (values: readonly bigint[]) =>
  values.reduce((result, value) => (value > result ? value : result), 0n)

const policyRulesFor = (config: ConfigService) => {
  const writePolicy = config.writePolicy
  if (!writePolicy) throw new QuoterTransactionError('configuration')
  const mempool = getChainAddress(config.chainId, 'midnightMempool')
  const rules: Record<Exclude<QuoterTransactionOperation, 'ratify'>, PolicyRule> & {
    ratify?: PolicyRule
  } = {
    publish: {
      target: mempool,
      maxGasLimit: writePolicy.maxPublicationGas,
      maxDataBytes: writePolicy.maxPublicationDataBytes
    },
    cancel: {
      target: config.setup.midnight,
      selector: toFunctionSelector(getAbiItem({ abi: midnightAbi, name: 'setConsumed' })),
      maxGasLimit: writePolicy.maxCancellationGas,
      maxDataBytes: 100
    },
    'cancel-batch': {
      target: config.setup.midnight,
      selector: toFunctionSelector(getAbiItem({ abi: midnightAbi, name: 'multicall' })),
      maxGasLimit: writePolicy.maxBatchCancellationGas,
      maxDataBytes: writePolicy.maxBatchCancellationDataBytes
    }
  }
  if (writePolicy.maxRatificationGas !== undefined) {
    rules.ratify = {
      target: config.setup.ratifier,
      selector: toFunctionSelector(
        getAbiItem({ abi: setterRatifierAbi, name: 'setIsRootRatified' })
      ),
      maxGasLimit: writePolicy.maxRatificationGas,
      maxDataBytes: 100
    }
  }
  return rules
}

const policyFor = (config: ConfigService, rules: ReturnType<typeof policyRulesFor>): Policy => {
  const writePolicy = config.writePolicy
  if (!writePolicy) throw new QuoterTransactionError('configuration')
  const ruleList = Object.values(rules)
  return {
    chainId: config.chainId,
    targets: ruleList.map(rule => rule.target),
    maxFeePerGasWei: writePolicy.maxFeePerGasWei,
    maxSpendWei: writePolicy.maxTransactionSpendWei,
    maxGasLimit: maximum(ruleList.map(rule => rule.maxGasLimit)),
    maxDataBytes: Math.max(...ruleList.map(rule => rule.maxDataBytes)),
    rules: ruleList
  }
}

/**
 * Creates the invocation-scoped signer nonce owner and guarded transaction path.
 * @param config - Validated write-mode configuration and policy ceilings.
 * @param account - Local or non-exportable signer account.
 * @param logger - Diagnostic queue and signer logger.
 * @returns The only transaction executor used by the invocation.
 * @throws When write policy configuration is unavailable.
 */
export const createQuoterTransactionExecutor = (
  config: ConfigService,
  account: LocalAccount,
  logger: Logger = quietLogger
): QuoterTransactionExecutor => {
  const writePolicy = config.writePolicy
  if (!writePolicy) throw new QuoterTransactionError('configuration')
  const chain = supportedChain(config.chainId)
  const client = createPublicClient({
    chain,
    transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
  })
  const operationRules = policyRulesFor(config)
  const signer = createAccountSigner({
    account,
    chain,
    rpcUrl: config.rpcUrl,
    policy: policyFor(config, operationRules),
    logger
  })
  const queue = createPendingQueue({
    send: signer.send,
    getReceipt: signer.getReceipt,
    getBaseFee: signer.getBaseFee,
    syncNonce: signer.syncNonce,
    getConsumedNonce: signer.consumedNonce,
    maxFeeWei: writePolicy.maxFeePerGasWei,
    maxSpendWei: writePolicy.maxTransactionSpendWei,
    logger
  })
  let reconciliationRequired = false

  return {
    signer: account.address,
    async assertNoPendingNonce() {
      const [latest, pending] = await Promise.all([
        client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
        client.getTransactionCount({ address: account.address, blockTag: 'pending' })
      ])
      if (latest !== pending) throw new QuoterTransactionError('unknown-pending-nonce')
    },
    async execute(parameters) {
      if (reconciliationRequired) throw new QuoterTransactionError('reconciliation-required')
      if (parameters.transaction.value !== 0n) {
        throw new QuoterTransactionError('submission-refused')
      }
      const operationRule = operationRules[parameters.operation]
      const selector = parameters.transaction.data.slice(0, 10).toLowerCase()
      if (
        !operationRule ||
        !isAddressEqual(parameters.transaction.to, operationRule.target) ||
        (operationRule.selector !== undefined && selector !== operationRule.selector.toLowerCase())
      ) {
        throw new QuoterTransactionError('submission-refused')
      }
      const simulation = await simulateCall(client, {
        eoa: account.address,
        to: parameters.transaction.to,
        data: parameters.transaction.data,
        value: 0n
      })
      if (simulation.status !== 'ok') throw new QuoterTransactionError('simulation-reverted')

      const fees = initialFees(
        await signer.getBaseFee(),
        writePolicy.maxFeePerGasWei,
        writePolicy.priorityFeePerGasWei
      )
      const submitted = await queue.submitTracked({
        request: { to: parameters.transaction.to, data: parameters.transaction.data },
        label: parameters.label,
        ...fees,
        onBroadcast: broadcast => parameters.onTransactionSubmitted?.(broadcast.txHash)
      })
      if (!submitted.sent) throw new QuoterTransactionError('submission-refused')

      reconciliationRequired = true
      try {
        const deadline = Date.now() + config.transactionReceiptTimeoutMs
        let settlement: Awaited<typeof submitted.settlement> | undefined
        while (Date.now() < deadline) {
          await queue.onBlock(await client.getBlockNumber())
          settlement = await Promise.race([
            submitted.settlement,
            wait(Math.min(1_000, Math.max(1, deadline - Date.now()))).then(() => undefined)
          ])
          if (settlement !== undefined) break
        }
        if (settlement === undefined) throw new QuoterTransactionError('transaction-pending')

        reconciliationRequired = false
        if (settlement.kind === 'confirmed-success') return settlement.txHash
        if (settlement.kind === 'confirmed-revert') {
          throw new QuoterTransactionError('transaction-reverted')
        }
        throw new QuoterTransactionError('transaction-dropped')
      } catch (error) {
        if (
          error instanceof QuoterTransactionError &&
          ['transaction-pending', 'transaction-reverted', 'transaction-dropped'].includes(
            error.operation
          )
        ) {
          throw error
        }
        throw new QuoterTransactionError('transaction-pending')
      }
    }
  }
}
