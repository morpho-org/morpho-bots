import type {
  DurableLedger,
  Entry,
  KernelActivity,
  KernelChain,
  KernelConfig,
  Log,
  TxPayload
} from '@repo/kernel'
import type { Address, Hex, LocalAccount } from 'viem'

import {
  MAX_CONTINUOUS_FEE,
  midnightAbi,
  type Offer,
  setterRatifierAbi
} from '@morpho-org/midnight-sdk'
import { getChainAddress, MathLib } from '@morpho-org/morpho-ts'
import { createLedgerStore, LEDGER_FORMAT } from '@repo/kernel'
import {
  blocksFor,
  reorgDepthFor,
  callAt,
  createAccountSigner,
  createKernelChain,
  createKernelEffects,
  createKeystoreAccount,
  createKmsAccount,
  type KeystoreDependencies,
  type KmsSigner,
  type Logger,
  type Policy,
  type PolicyRule,
  SignerAccountError
} from '@repo/kit'
import {
  midnightCommitmentGroup,
  midnightCommitmentRead,
  midnightOffersValidator
} from '@repo/validators'
import { join } from 'node:path'
import {
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  http,
  isAddressEqual,
  parseAbi,
  toFunctionSelector
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { MonitoringEvent } from './application/monitoring/monitoring-event'
import type { ConfigService } from './config/config.service'
import type { QuoterHosting } from './graph'

import { operatorErrorName } from './application/monitoring/operator-error-name.utils'
import { supportedChain } from './config/supported-chains.utils'
import { DryRunError, QuoterTransactionError } from './errors'
import { createDryWorld } from './infrastructure/kernel/dry-world'
import { strategyStateDirectory } from './infrastructure/strategy-state/strategy-state-file.utils'

/** The workflow that submitted a plan, carried as its intent id's prefix. */
export type QuoterWorkflow = 'ladder' | 'bootstrap' | 'invalidation'

/** One offer group the kernel holds for the maker, with the offers it was signed with. */
export type KernelGroup = {
  groupId: Hex
  workflow?: QuoterWorkflow
  /** `retired` groups are kept until restart so a lagging index never reads them as foreign. */
  state: 'exposed' | 'live' | 'revoking' | 'retired'
  offers: readonly Offer[]
}

/** A replaced book stays reserved until its cancellation is final, so a republish holds two books. */
const REPUBLISH_OVERLAP = 2n
/** How many transactions may await finality at once; each holds the per-transaction spend ceiling. */
const TRANSACTIONS_IN_FLIGHT = 16n

const POLL_MS = 1_000
/** Each window is a time in the chain's blocks, at no fewer blocks than mainnet's 12s ones need. */
const MAX_SIM_LAG_MS = 6_000
const MIN_SIM_LAG_BLOCKS = 3
const STUCK_MS = 20_000
const MIN_STUCK_BLOCKS = 10
/**
 * A desire read holds three polls, at most three minutes; a release restored after a crash also
 * waits this long, so it stays near that.
 */
const MAX_EVIDENCE_AGE_MS = 4 * 60_000
const MIN_EVIDENCE_AGE_BLOCKS = 128
const LATCH_BOUND_MS = 200_000
const MIN_LATCH_BOUND_BLOCKS = 100
const RECOVERY_BOUND_MS = 15 * 60_000
const MAX_RECOVERY_ATTEMPTS = 3
const MAX_DISPATCH_LAG_MS = 10_000
/** Missed cycles a workflow may skip before the kernel withdraws the groups it stopped affirming. */
const AFFIRMATION_CYCLES = 3

/** The ledger file for one chain and signer, beside the strategy state. */
const kernelLedgerPath = (chainId: number, signer: Address, directory?: string) =>
  join(strategyStateDirectory(directory), `kernel-${chainId}-${signer.toLowerCase()}.json`)

const operationRules = (config: ConfigService): PolicyRule[] => {
  const policy = config.writePolicy!
  const rules: PolicyRule[] = [
    {
      target: getChainAddress(config.chainId, 'midnightMempool'),
      maxGasLimit: policy.maxPublicationGas,
      maxDataBytes: policy.maxPublicationDataBytes
    },
    {
      target: config.setup.midnight,
      selector: toFunctionSelector(getAbiItem({ abi: midnightAbi, name: 'setConsumed' })),
      maxGasLimit: policy.maxCancellationGas,
      maxDataBytes: 100
    },
    {
      target: config.setup.midnight,
      selector: toFunctionSelector(getAbiItem({ abi: midnightAbi, name: 'multicall' })),
      maxGasLimit: policy.maxBatchCancellationGas,
      maxDataBytes: policy.maxBatchCancellationDataBytes
    }
  ]
  if (policy.maxRatificationGas !== undefined) {
    rules.push({
      target: config.setup.ratifier,
      selector: toFunctionSelector(
        getAbiItem({ abi: setterRatifierAbi, name: 'setIsRootRatified' })
      ),
      maxGasLimit: policy.maxRatificationGas,
      maxDataBytes: 100
    })
  }
  return rules
}

const signingPolicy = (config: ConfigService, rules: readonly PolicyRule[]): Policy => {
  const policy = config.writePolicy!
  return {
    chainId: config.chainId,
    targets: rules.map(rule => rule.target),
    maxFeePerGasWei: policy.maxFeePerGasWei,
    maxSpendWei: policy.maxTransactionSpendWei,
    maxGasLimit: rules.reduce((max, rule) => (rule.maxGasLimit > max ? rule.maxGasLimit : max), 0n),
    maxDataBytes: Math.max(...rules.map(rule => rule.maxDataBytes)),
    rules
  }
}

/** Any positive bound lets a dry plan take a fee; at zero every transaction step is refused. */
const DRY_TRANSACTION_SPEND_WEI = MathLib.WAD
/** A read-only run's dry kernel signs nothing, so its validator reads offers at any fee cap. */
const DRY_POLICY = {
  maxContinuousFeeCap: MAX_CONTINUOUS_FEE,
  maxTransactionSpendWei: DRY_TRANSACTION_SPEND_WEI
}

/**
 * The kernel's configuration for the quoter's signer. Exposure is read only by the Midnight offers
 * validator; the caps bound it from configuration alone.
 * @param config - Validated runtime config; without a write policy the dry policy applies.
 * @param signer - The address the kernel signs as.
 * @returns The kernel configuration.
 */
export const quoterKernelConfig = (config: ConfigService, signer: Address): KernelConfig => {
  const policy = config.writePolicy ?? DRY_POLICY
  const chain = supportedChain(config.chainId)
  const slowestCycleMs = Math.max(
    60_000,
    ...config.ladder.map(market => market.loopIntervalSeconds * 1_000)
  )
  return {
    chainId: config.chainId,
    account: signer,
    validators: [
      midnightOffersValidator({
        chainId: config.chainId,
        maker: config.setup.maker,
        markets: config.setup.marketIds,
        maxContinuousFeeCap: policy.maxContinuousFeeCap,
        debtMarkets: config.ladder
          .filter(market => market.debt !== undefined)
          .map(market => market.marketId)
      })
    ],
    policy: {
      targets: [
        getChainAddress(config.chainId, 'midnightMempool'),
        getChainAddress(config.chainId, 'midnight'),
        getChainAddress(config.chainId, 'setterRatifier')
      ],
      recoveryTargets: [getChainAddress(config.chainId, 'midnight')]
    },
    caps: {
      [`loan:${config.setup.loanAsset.toLowerCase()}`]:
        REPUBLISH_OVERLAP * config.setup.requiredAllowance,
      ...Object.fromEntries(
        config.ladder.flatMap(market =>
          market.debt === undefined
            ? []
            : [
                [
                  `debt:${market.marketId.toLowerCase()}`,
                  REPUBLISH_OVERLAP * market.debt.maximumDebtUnits
                ]
              ]
        )
      ),
      native: TRANSACTIONS_IN_FLIGHT * policy.maxTransactionSpendWei
    },
    observedResources: [],
    feeReserve: policy.maxTransactionSpendWei,
    feePolicy: () => policy.maxTransactionSpendWei,
    maxSimLagBlocks: blocksFor(MAX_SIM_LAG_MS, chain, MIN_SIM_LAG_BLOCKS),
    maxEvidenceAgeBlocks: blocksFor(MAX_EVIDENCE_AGE_MS, chain, MIN_EVIDENCE_AGE_BLOCKS),
    stuckBlocks: blocksFor(STUCK_MS, chain, MIN_STUCK_BLOCKS),
    latchBoundBlocks: blocksFor(LATCH_BOUND_MS, chain, MIN_LATCH_BOUND_BLOCKS),
    recoveryBoundMs: RECOVERY_BOUND_MS,
    revokeAfterStaleMs: AFFIRMATION_CYCLES * (slowestCycleMs + config.transactionReceiptTimeoutMs),
    maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
    maxDispatchLagMs: MAX_DISPATCH_LAG_MS
  }
}

const emitSafely = (
  writeEvent: ((event: MonitoringEvent) => void | Promise<void>) | undefined,
  event: MonitoringEvent
) => {
  try {
    void Promise.resolve(writeEvent?.(event)).catch(() => {})
  } catch {
    // A failing log writer must never wedge the kernel.
  }
}

/** Writes the signer's policy refusals as `signer.policy_violation` records, and nothing else. */
const signerLogger = (writeEvent: Parameters<typeof emitSafely>[0]): Logger => {
  const quiet = () => undefined
  return {
    debug: quiet,
    info: quiet,
    warn: quiet,
    error: (event, fields) => {
      if (event === 'signer.policy_violation')
        emitSafely(writeEvent, { event, ...fields } as MonitoringEvent)
    }
  }
}

const reportKernelErrors =
  (writeEvent: ((event: MonitoringEvent) => void | Promise<void>) | undefined) =>
  (source: string, error: unknown) =>
    emitSafely(writeEvent, { event: 'kernel.error', source, errorName: operatorErrorName(error) })

/**
 * Writes each kernel transition's sends and receipts as `transaction.lifecycle` records, and its
 * commitment moves as `kernel.commitment` records.
 * @param writeEvent - Record writer; a missing or failing writer never wedges the kernel.
 * @returns An activity listener that holds nothing between transitions.
 */
export const createKernelLog =
  (writeEvent?: (event: MonitoringEvent) => void | Promise<void>) =>
  (activity: readonly KernelActivity[]) => {
    for (const a of activity) {
      if (a.type === 'sent')
        emitSafely(writeEvent, {
          event: 'transaction.lifecycle',
          state:
            a.status === 'unknown'
              ? 'broadcast-unknown'
              : a.status === 'accepted'
                ? a.replaces
                  ? 'replaced'
                  : 'submitted'
                : 'dropped',
          nonce: a.nonce,
          txHash: a.hash as Hex,
          intentId: a.intentId,
          ...(a.replaces && a.status === 'accepted' && { previousTxHash: a.replaces as Hex }),
          ...((a.status === 'rejected' || a.status === 'withheld') && { reason: a.status })
        })
      if (a.type === 'resolved' && a.winner !== null)
        emitSafely(writeEvent, {
          event: 'transaction.lifecycle',
          state: a.success ? 'confirmed' : 'reverted',
          nonce: a.nonce,
          txHash: a.winner as Hex,
          blockNumber: BigInt(a.block)
        })
      if (a.type === 'entry')
        emitSafely(writeEvent, {
          event: 'kernel.commitment',
          groupId: midnightCommitmentGroup(a.id),
          intentId: a.intentId,
          state: a.to,
          ...(a.reason && { reason: a.reason })
        })
    }
  }

/** How a ledger read from disk is handed to a dry kernel: every entry, with no candidate open. */
const dryLedger = (
  config: ConfigService,
  entries: Readonly<Record<string, Entry>>
): DurableLedger | undefined => {
  const kept = Object.entries(entries).flatMap(([id, entry]) =>
    entry.state === 'exposed' || entry.state === 'live' || entry.state === 'revoking'
      ? [
          [
            id,
            {
              spec: entry.spec,
              state: entry.state,
              intentId: entry.intentId,
              validator: entry.validator,
              creators: entry.creators,
              deadCreators: entry.deadCreators,
              origin: entry.origin!,
              consumedFinal: entry.consumedFinal,
              compensate: entry.compensate,
              affirmedBy: entry.affirmedAt
            }
          ] as const
        ]
      : []
  )
  if (kept.length === 0) return undefined
  return {
    header: { format: LEDGER_FORMAT, chainId: config.chainId, account: config.setup.maker, seq: 1 },
    nextNonce: null,
    entries: Object.fromEntries(kept),
    nonces: {},
    submissions: {},
    watermarks: {},
    conflictMarks: [],
    evidenceFloor: 0,
    releases: {}
  }
}

const dryEvents = parseAbi([
  'event SetConsumed(address indexed caller, bytes32 indexed group, uint256 amount, address indexed onBehalf)',
  'event SetIsRootRatified(address indexed caller, address indexed maker, bytes32 indexed root, bool newIsRootRatified)'
])

/** A call's decoding under `abi`, or nothing when the calldata is not one of its functions. */
const decodeWith = <const abi extends typeof midnightAbi | typeof setterRatifierAbi>(
  abi: abi,
  data: Hex
) => {
  try {
    return decodeFunctionData({ abi, data })
  } catch {
    return undefined
  }
}

/**
 * The logs a quoter transaction emits once mined, as its validator confirms them.
 * @param maker - The maker the logs are attributed to.
 * @returns A mapper from a transaction payload to its logs; an unrecognized call emits none.
 */
export const quoterReceiptLogs =
  (maker: Address) =>
  (payload: TxPayload): readonly Log[] => {
    const data = payload.data as Hex
    const ratification = decodeWith(setterRatifierAbi, data)
    if (ratification?.functionName === 'setIsRootRatified') {
      const [, root, ratified] = ratification.args
      return [
        {
          address: payload.to,
          topics: encodeEventTopics({
            abi: dryEvents,
            eventName: 'SetIsRootRatified',
            args: { caller: maker, maker, root }
          }) as string[],
          data: encodeAbiParameters([{ type: 'bool' }], [ratified])
        }
      ]
    }
    const call = decodeWith(midnightAbi, data)
    const calls = call?.functionName === 'multicall' ? (call.args[0] as readonly Hex[]) : [data]
    return calls.flatMap(inner => {
      const cancel = decodeWith(midnightAbi, inner)
      if (cancel?.functionName !== 'setConsumed') return []
      const [group, amount, onBehalf] = cancel.args as readonly [Hex, bigint, Address]
      return [
        {
          address: payload.to,
          topics: encodeEventTopics({
            abi: dryEvents,
            eventName: 'SetConsumed',
            args: { caller: maker, group, onBehalf }
          }) as string[],
          data: encodeAbiParameters([{ type: 'uint256' }], [amount])
        }
      ]
    })
  }

/**
 * The configured chain's heads, blocks and finality, for a read-only run's dry kernel to follow, so
 * its world reads pin to real blocks.
 * @param config - Validated runtime config.
 * @returns The chain reads a dry world follows.
 */
export const followedChain = (
  config: ConfigService
): Pick<KernelChain, 'latest' | 'block' | 'safe'> =>
  createKernelChain({
    client: createPublicClient({
      chain: supportedChain(config.chainId),
      transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
    }),
    account: config.setup.maker,
    finality: config.finality,
    commitment: () => Promise.reject(new DryRunError('a dry run observes no commitment'))
  })

/**
 * A kernel that signs and sends nothing, starting from what an earlier run's ledgers hold: the real
 * reducer on a dry world whose receipts emit what the quoter's transactions would.
 * @param config - Validated runtime config.
 * @param entries - The maker's entries the ledgers on disk record, for a read-only run.
 * @param writeEvent - Where the kernel's failed reads and effects are reported.
 * @param follow - The real chain the dry chain follows; without it every block is fabricated.
 * @returns The dry kernel hosting.
 */
export const dryHosting = (
  config: ConfigService,
  entries: Readonly<Record<string, Entry>> = {},
  writeEvent?: (event: MonitoringEvent) => void,
  follow?: Pick<KernelChain, 'latest' | 'block' | 'safe'>
): QuoterHosting => {
  const maker = config.setup.maker
  const ledger = dryLedger(config, entries)
  return {
    ...createDryWorld({
      ...(ledger ? { ledger } : {}),
      logs: quoterReceiptLogs(maker),
      ...(follow && { follow })
    }),
    dry: true,
    config: quoterKernelConfig(config, maker),
    enrollment: ledger ? 'enrolled' : 'enrolling',
    pollMs: POLL_MS,
    effectTimeoutMs: config.requestTimeoutMs,
    reorgDepth: reorgDepthFor(supportedChain(config.chainId)),
    onError: reportKernelErrors(writeEvent)
  }
}

/**
 * The account the kernel signs with, with no nonce manager: the kernel allocates every nonce.
 * @param identity - Validated write-enabled signer identity.
 * @param dependencies - Overrides for the keystore read and decryption, and the KMS calls.
 * @returns The private-key, keystore, or KMS account the identity selects.
 * @throws `SignerAccountError` when the credential cannot be loaded, or the account is not the one
 * the identity requires: the maker itself, or for KMS a separate key the maker authorized.
 */
export const createSignerAccount = async (
  identity: Exclude<ConfigService['identity'], { readOnly: true }>,
  dependencies: KeystoreDependencies & { kms?: KmsSigner } = {}
): Promise<LocalAccount> => {
  const account =
    identity.method === 'private-key'
      ? privateKeyToAccount(identity.privateKey)
      : identity.method === 'keystore'
        ? await createKeystoreAccount(identity, dependencies)
        : await createKmsAccount(identity, dependencies.kms)
  if ((identity.method === 'aws') === isAddressEqual(account.address, identity.maker))
    throw new SignerAccountError('signer-address')
  return account
}

/**
 * The kernel the quoter's engine hosts for its signer: its configuration, ledger, chain reads, and
 * effects. The engine builds every plan's dependent step itself.
 * @param parameters - Validated write configuration, the signing account, and optional writers.
 * @returns The kernel's hosting, and the signer it signs as.
 * @throws `QuoterTransactionError` when writes are not configured, or the signer is not the one
 * the configuration names.
 * @remarks Every transaction the kernel signs also passes the kit signer's policy.
 */
export const quoterKernelSpec = (parameters: {
  config: ConfigService
  account: LocalAccount
  writeEvent?: (event: MonitoringEvent) => void | Promise<void>
  stateDirectory?: string
}): { hosting: QuoterHosting; signer: Address } => {
  const { config, account } = parameters
  const writePolicy = config.writePolicy
  const identity = config.identity
  if (!writePolicy || identity.readOnly) throw new QuoterTransactionError('configuration')
  // A KMS signer is a separate key the maker authorized; every other method signs as the maker.
  if ((identity.method === 'aws') === isAddressEqual(account.address, config.setup.maker))
    throw new QuoterTransactionError('signer-identity-mismatch')
  const chain = supportedChain(config.chainId)
  const client = createPublicClient({
    chain,
    transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
  })
  const rules = operationRules(config)
  const policy = signingPolicy(config, rules)
  const signer = createAccountSigner({
    account,
    chain,
    rpcUrl: config.rpcUrl,
    policy,
    logger: signerLogger(parameters.writeEvent)
  })
  const commitments = midnightCommitmentRead(config.chainId, config.setup.maker)
  const effects = createKernelEffects({
    client,
    signer,
    typedSigner: account,
    maxFeePerGasWei: writePolicy.maxFeePerGasWei,
    maxGasLimit: rules.reduce(
      (min, rule) => (rule.maxGasLimit < min ? rule.maxGasLimit : min),
      policy.maxGasLimit
    ),
    materialize: () => Promise.reject(new QuoterTransactionError('configuration'))
  })
  return {
    signer: account.address,
    hosting: {
      config: quoterKernelConfig(config, account.address),
      store: createLedgerStore(
        kernelLedgerPath(config.chainId, account.address, parameters.stateDirectory)
      ),
      chain: createKernelChain({
        client,
        account: account.address,
        finality: config.finality,
        commitment: async (id, at) =>
          commitments.observe(await callAt(client, at, commitments.request(id)))
      }),
      effects,
      enrollment: writePolicy.enrollment,
      pollMs: POLL_MS,
      effectTimeoutMs: config.requestTimeoutMs,
      reorgDepth: reorgDepthFor(chain),
      onError: reportKernelErrors(parameters.writeEvent)
    }
  }
}
