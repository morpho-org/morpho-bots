import type { Entry } from '@repo/kernel'
import type { Address, Hex, PublicClient } from 'viem'

import { midnightAbi } from '@morpho-org/midnight-sdk'
import { midnightCommitmentGroup } from '@repo/validators'
import { createPublicClient, http } from 'viem'

import type { OperatorAdapterOperation } from '../../application/monitoring/operator-error-name.utils'
import type { ConfigService } from '../../config/config.service'
import type { KernelGroup } from '../../kernel'
import type { QuoterEngine, StartupWithdrawal } from '../../run'
import type { MakerOfferGroup } from '../provider/offer-groups.utils'

import { operatorErrorName } from '../../application/monitoring/operator-error-name.utils'
import { supportedChain } from '../../config/supported-chains.utils'
import {
  OfferInvalidationFailedError,
  BootstrapAdapterError,
  KernelRefusedError,
  KernelStopError,
  OfferInvalidationAdapterError
} from '../../errors'
import { readLedgerGroups } from '../kernel/quoter-ownership'
import { readMakerOfferGroups } from '../provider/offer-groups.utils'
import { offerInvalidationGroupIds } from './offer-invalidation-group.utils'

/** One cancellation transaction observed immediately after it is broadcast. */
export type OfferInvalidationTransactionSubmittedEvent = {
  event: 'offer-invalidation.transaction-submitted'
  groupId: Hex
  txHash: Hex
}

/** One group whose cancellation completed or was rendered in read-only mode. */
type InvalidatedOfferGroup = { groupId: Hex; txHash?: Hex }

/** Successful result for an all-groups or explicitly selected invalidation request. */
export type OfferInvalidationSuccessReport = {
  status: 'applied' | 'logged'
  scope: 'all' | 'group'
  matchedGroups: number
  invalidatedGroups: readonly InvalidatedOfferGroup[]
}

/** Failed result retaining completed cancellations and sanitized remaining failures. */
export type OfferInvalidationFailureReport = {
  status: 'failed'
  scope: 'all' | 'group'
  matchedGroups: number
  invalidatedGroups: readonly InvalidatedOfferGroup[]
  failures: readonly {
    stage: 'preflight' | 'selection' | 'invalidation'
    groupId?: Hex
    errorName: string
    txHash?: Hex
  }[]
}

type Failure = OfferInvalidationFailureReport['failures'][number]

/** What the command reads, injectable for tests. */
type InvalidationReads = Readonly<{
  client: Pick<PublicClient, 'getChainId' | 'getCode' | 'getBalance' | 'readContract'>
  groups: () => Promise<readonly MakerOfferGroup[]>
}>

const providerOperation = async <Result>(
  operation: OperatorAdapterOperation,
  execute: () => Promise<Result>
): Promise<Result> => {
  try {
    return await execute()
  } catch (error) {
    if (error instanceof OfferInvalidationAdapterError) throw error
    throw new OfferInvalidationAdapterError(operation)
  }
}

/** What one withdrawal did: the transaction it included, and why it is not confirmed, if it is not. */
type Withdrawn = Readonly<{ txHash?: Hex; error?: unknown }>

/**
 * The `invalidate` command: cancels every active group the API lists for the maker and every group
 * the kernel ledger holds, or one group whether or not the API has indexed it, by starting the
 * quoter over no market, whose startup cancels them in one transaction through the kernel. A group
 * the ledger does not hold is cancelled as cancel-only. A read-only run renders the same selection
 * and signs nothing. A cancellation is reported only once it settled and the kernel no longer holds
 * the group exposed or live.
 * @param config - Validated runtime config.
 * @param context - `writer`: the signer and an engine start; without a
 * writer the run is read-only.
 * @returns `run`, which resolves with an applied or logged report.
 * @throws From `run`: `OfferInvalidationFailedError` when preflight, selection or the cancellation
 * fails, keeping the transaction a failed cancellation included; a maker-wide cancellation that
 * stops unclean fails with `KernelStopError`.
 * @remarks The writer runs a kernel over the signer's ledger, so the bot must be stopped first.
 * Preflight checks chain identity, deployed Midnight bytecode and native reserves, without
 * requiring healthy books, archive data, ratifier state, or allowance.
 */
export const createOfferInvalidation = (
  config: ConfigService,
  context: {
    writer?: Readonly<{
      signer: Address
      start: (options: {
        adopt?: (entry: Entry) => 'withdraw' | 'keep'
        cancel?: readonly Hex[]
        onStartup?: (withdrawal: StartupWithdrawal) => void
        onStartupSent?: (hash: Hex) => void
      }) => Promise<QuoterEngine>
    }>
    reads?: InvalidationReads
  }
) => {
  const { identity } = config
  const maker = identity.maker
  const writer = identity.readOnly ? undefined : context.writer
  const delegated = !identity.readOnly && identity.method === 'aws'
  const reads: InvalidationReads = context.reads ?? {
    client: createPublicClient({
      chain: supportedChain(config.chainId),
      transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
    }),
    groups: () =>
      readMakerOfferGroups({
        adapterError: BootstrapAdapterError,
        chainId: config.chainId,
        maker,
        morphoApiBaseUrl: config.morphoApiBaseUrl,
        requestTimeoutMs: config.requestTimeoutMs
      })
  }
  const { client } = reads

  const preflight = () =>
    providerOperation('preflight', async () => {
      const [chainId, code, signerBalance, signerAuthorized] = await Promise.all([
        client.getChainId(),
        client.getCode({ address: config.setup.midnight }),
        writer ? client.getBalance({ address: writer.signer }) : undefined,
        writer && delegated
          ? client.readContract({
              address: config.setup.midnight,
              abi: midnightAbi,
              functionName: 'isAuthorized',
              args: [maker, writer.signer]
            })
          : true
      ])
      const signerFloor = delegated ? config.setup.signerNativeReserve : config.setup.nativeReserve
      if (
        chainId !== config.chainId ||
        code === undefined ||
        code === '0x' ||
        (signerBalance !== undefined &&
          (signerFloor === undefined || signerBalance < signerFloor)) ||
        !signerAuthorized
      )
        throw new OfferInvalidationAdapterError('preflight')
    })

  const heldOf = (ledger: readonly KernelGroup[]) =>
    ledger.filter(group => group.state !== 'retired').map(group => group.groupId)

  /** The groups the command cancels, or renders read-only: every active indexed group, and every group the ledger holds. */
  const writable = (ledger: readonly KernelGroup[]) =>
    providerOperation('offer-groups-read', async () =>
      offerInvalidationGroupIds(await reads.groups(), heldOf(ledger), [])
    )

  /**
   * Starts the quoter over no market, so its startup cancels `groups`: every group the ledger holds
   * and the rest, or only `groupId`, keeping the ledger's other groups for the next start. The
   * cancellation counts only once it settled and the kernel holds none of the groups exposed or
   * live; whatever it included is kept, confirmed or not.
   */
  const withdraw = async (
    start: NonNullable<typeof writer>['start'],
    onSent: (hash: Hex) => void,
    groups: readonly Hex[],
    groupId?: Hex
  ): Promise<Withdrawn> => {
    let startup: StartupWithdrawal | undefined
    let sent: Hex | undefined
    const included = (): Withdrawn => {
      const hash = (startup?.included[0]?.hash as Hex | undefined) ?? sent
      return hash === undefined ? {} : { txHash: hash }
    }
    let engine: QuoterEngine
    try {
      engine = await start({
        cancel: groups,
        ...(groupId
          ? {
              adopt: entry =>
                midnightCommitmentGroup(entry.spec.id).toLowerCase() === groupId.toLowerCase()
                  ? 'withdraw'
                  : 'keep'
            }
          : {}),
        onStartup: withdrawal => {
          startup = withdrawal
        },
        onStartupSent: hash => {
          if (sent === undefined) onSent(hash)
          sent = hash
        }
      })
    } catch (error) {
      return { ...included(), error }
    }
    const held = engine.held().map(id => id.toLowerCase())
    const remaining = groupId ? held.includes(groupId.toLowerCase()) : held.length > 0
    const confirmed = startup?.notice === 'settled' && !remaining
    if (groupId || !confirmed) {
      if (groupId) await engine.abandon()
      else {
        engine.stop()
        await engine.stopped
      }
      return confirmed ? included() : { ...included(), error: new KernelRefusedError('adopted') }
    }
    engine.stop()
    if ((await engine.stopped).outcome !== 'clean')
      return { ...included(), error: new KernelStopError() }
    return included()
  }

  /** One group's cancellation: what it included, and why it is not confirmed, if it is not. */
  const withdrawGroup = async (
    start: NonNullable<typeof writer>['start'],
    onSent: (hash: Hex) => void,
    groupId: Hex
  ): Promise<Withdrawn> => {
    try {
      await readLedgerGroups(config.chainId, maker)
      return await withdraw(start, onSent, [groupId], groupId)
    } catch (error) {
      return { error }
    }
  }

  return {
    /** Withdraws the selected groups, or renders them in a read-only run. */
    run: async (
      parameters: {
        groupId?: Hex
        /** Called once per group when its withdrawal is first broadcast; a throw never interrupts it. */
        onTransactionSubmitted?: (
          event: OfferInvalidationTransactionSubmittedEvent
        ) => void | Promise<void>
      } = {}
    ): Promise<OfferInvalidationSuccessReport> => {
      const { groupId } = parameters
      const scope = groupId ? 'group' : 'all'
      const fail = (
        matchedGroups: number,
        failures: readonly Failure[],
        invalidatedGroups: readonly InvalidatedOfferGroup[] = []
      ) =>
        new OfferInvalidationFailedError({
          status: 'failed',
          scope,
          matchedGroups,
          invalidatedGroups,
          failures
        })
      const announce = (groupIds: readonly Hex[], txHash: Hex) => {
        for (const id of groupIds) {
          try {
            const event = {
              event: 'offer-invalidation.transaction-submitted' as const,
              groupId: id,
              txHash
            }
            void Promise.resolve(parameters.onTransactionSubmitted?.(event)).catch(() => undefined)
          } catch {
            // Diagnostic output cannot interrupt a withdrawal already broadcast.
          }
        }
      }

      try {
        await preflight()
      } catch (error) {
        throw fail(0, [
          {
            stage: 'preflight',
            ...(groupId ? { groupId } : {}),
            errorName: operatorErrorName(error)
          }
        ])
      }

      if (groupId) {
        if (!writer)
          return { status: 'logged', scope, matchedGroups: 1, invalidatedGroups: [{ groupId }] }
        const withdrawn = await withdrawGroup(
          writer.start,
          hash => announce([groupId], hash),
          groupId
        )
        const { txHash } = withdrawn
        if (withdrawn.error !== undefined || txHash === undefined)
          throw fail(1, [
            {
              stage: 'invalidation',
              groupId,
              errorName: operatorErrorName(withdrawn.error),
              ...(txHash ? { txHash } : {})
            }
          ])
        return {
          status: 'applied',
          scope,
          matchedGroups: 1,
          invalidatedGroups: [{ groupId, txHash }]
        }
      }

      let selected: Hex[]
      let ledger: readonly KernelGroup[] = []
      try {
        ledger = await readLedgerGroups(config.chainId, maker)
        selected = [...new Set(await writable(ledger))]
      } catch (error) {
        throw fail(0, [{ stage: 'selection', errorName: operatorErrorName(error) }])
      }
      if (!writer)
        return {
          status: 'logged',
          scope,
          matchedGroups: selected.length,
          invalidatedGroups: selected.map(id => ({ groupId: id }))
        }

      let txHash: Hex | undefined
      if (selected.length > 0) {
        const withdrawn = await withdraw(writer.start, hash => announce(selected, hash), selected)
        txHash = withdrawn.txHash
        if (withdrawn.error !== undefined)
          throw fail(
            selected.length,
            selected.map(id => ({
              stage: 'invalidation' as const,
              groupId: id,
              errorName: operatorErrorName(withdrawn.error),
              ...(txHash ? { txHash } : {})
            }))
          )
      }
      const invalidatedGroups = selected.map(id => ({ groupId: id, ...(txHash ? { txHash } : {}) }))
      return { status: 'applied', scope, matchedGroups: selected.length, invalidatedGroups }
    }
  }
}

/** The `invalidate` command. */
export type OfferInvalidation = ReturnType<typeof createOfferInvalidation>
