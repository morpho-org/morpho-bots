import type { Hex } from 'viem'

import type { LadderMakeService } from '../../application/ladder/ladder-quoter.service'
import type {
  LadderMakeResult,
  LadderSubmittedTransaction,
  LadderTransactionSubmittedObserver
} from '../../application/ladder/ladder-verbose'
import type { LadderQuoteSet } from '../../domain/ladder/ladder'
import type { LadderGroupReference } from './ladder-group-ownership.utils'

import { LadderOwnershipCleanupError } from '../../application/ladder/ladder-ownership-cleanup.error'
import { operatorErrorName } from '../../application/operator-error-name.utils'
import { LadderAdapterError } from './ladder-adapter.error'
import { LadderHardHaltError } from './ladder-hard-halt.error'
import { assertLadderProspectiveSpread } from './ladder-spread.utils'

type LadderBookOffer = { groupId?: Hex; marketId: Hex; buy: boolean; tick: bigint }
type LadderOwnedGroup = { groupId: Hex; maxAssets: bigint }

/** Blocking transport used by the serialized ladder make adapter. */
export interface LadderOfferTransport {
  /** Reconstructs active quote semantics. @param marketId - Selected market. @returns Active quote set or no quote. */
  readActive(marketId: Hex): Promise<LadderQuoteSet | undefined>
  /** Lists every durably owned group and its exact consumption cap. @returns Groups used for exhaustive cleanup. */
  listOwnedGroups(): Promise<readonly LadderOwnedGroup[]>
  /** Reads authoritative on-chain consumption. @param groupId - Strategy-owned group. @returns Current consumed assets. */
  readGroupConsumed(groupId: Hex): Promise<bigint>
  /** Lists active owned group IDs, optionally for one market. @param marketId - Optional market filter. @returns Distinct group IDs. */
  listActiveGroupIds(marketId?: Hex): Promise<readonly Hex[]>
  /** Lists the maker's complete live offer book. @returns Every offer needed for spread safety. */
  listBookOffers(): Promise<readonly LadderBookOffer[]>
  /** Prepares a policy-checked desired tree without broadcasting it. @param quote - Exact desired quote set. @returns Publication metadata and one-shot ratifier/publisher. */
  preparePublication(quote: LadderQuoteSet): Promise<{
    groupIds: readonly Hex[]
    groups: readonly LadderGroupReference[]
    prospective: readonly LadderBookOffer[]
    /**
     * Ratifies when required, publishes the policy-checked tree, and waits for every receipt.
     * @param onTransactionSubmitted - Optional safe observer notified after each wallet submission.
     * @returns Confirmed ratification and publication transactions in submission order.
     */
    publish(
      onTransactionSubmitted?: LadderTransactionSubmittedObserver
    ): Promise<Hex | void | readonly LadderSubmittedTransaction[]>
  }>
  /** Durably reserves future groups. @param publication - Desired quote and derived group mapping. @returns Completion after atomic storage. */
  reservePublication(publication: {
    marketId: Hex
    quote: LadderQuoteSet
    groups: readonly LadderGroupReference[]
  }): Promise<void>
  /** Confirms a successful publication. @param groupIds - Complete published group set. @returns Completion after atomic storage. */
  confirmPublication(groupIds: readonly Hex[]): Promise<void>
  /** Removes a definitely unpublished reservation. @param groupIds - Complete reserved group set. @returns Completion after atomic storage. */
  releasePublication(groupIds: readonly Hex[]): Promise<void>
  /** Invalidates one active owned group. @param groupId - Protocol group ID. @param onTransactionSubmitted - Optional safe observer notified after wallet submission. @returns Canonical transaction hash after receipt confirmation. */
  invalidate(
    groupId: Hex,
    onTransactionSubmitted?: LadderTransactionSubmittedObserver
  ): Promise<Hex | void>
  /** Removes canceled groups from durable ownership. @param groupIds - Successfully canceled IDs. @returns Completion after atomic storage. */
  forgetGroups(groupIds: readonly Hex[]): Promise<void>
}

/** Serialized live adapter for ladder publication, replacement, and safety cleanup. */
export class MidnightLadderMakeService implements LadderMakeService {
  private queue = Promise.resolve()
  private readonly confirmedCanceledGroups = new Set<Hex>()

  /** Creates one mutation queue. @param transport - Protocol, book, and ownership transport. */
  constructor(private readonly transport: LadderOfferTransport) {}

  /** Reads active quote state. @param marketId - Selected market. @returns Reconstructed quote or no active quote. */
  readActive(marketId: Hex) {
    return this.transport.readActive(marketId)
  }

  /**
   * Reconciles one quote set inside the singleton mutation queue.
   * @param parameters - Selected market, desired quote, and audited reason.
   * @returns Completion after every required receipt and ownership update.
   * @throws When preparation, spread validation, cancellation, publication, or storage fails.
   * @remarks The future groups are reserved before old groups are invalidated. A publication whose
   * submission outcome is unknown remains reserved so a restart still recognizes it as owned.
   */
  reconcile(parameters: Parameters<LadderMakeService['reconcile']>[0]) {
    return this.enqueue(async () => {
      const submittedTransactions: LadderSubmittedTransaction[] = []
      if (parameters.reason === 'rest') return { submittedTransactions }
      const spreadReplacedGroupIds = new Set([
        ...(await this.transport.listActiveGroupIds(parameters.marketId)),
        ...this.confirmedCanceledGroups
      ])
      const invalidatedGroupIds = new Set(
        [...spreadReplacedGroupIds].filter(groupId => !this.confirmedCanceledGroups.has(groupId))
      )
      const publication = parameters.desired
        ? await this.transport.preparePublication(parameters.desired)
        : undefined
      if (publication) {
        assertLadderProspectiveSpread({
          marketId: parameters.marketId,
          replacedGroupIds: spreadReplacedGroupIds,
          book: await this.transport.listBookOffers(),
          prospective: publication.prospective
        })
        await this.transport.reservePublication({
          marketId: parameters.marketId,
          quote: parameters.desired!,
          groups: publication.groups
        })
      }

      try {
        for (const groupId of invalidatedGroupIds) {
          const txHash = await this.transport.invalidate(
            groupId,
            this.safeObserver(parameters.onTransactionSubmitted)
          )
          const cancellation = txHash ? ({ operation: 'cancel', txHash } as const) : undefined
          if (cancellation) submittedTransactions.push(cancellation)
          this.confirmedCanceledGroups.add(groupId)
          try {
            await this.transport.forgetGroups([groupId])
          } catch (error) {
            throw new LadderOwnershipCleanupError(
              groupId,
              [...submittedTransactions],
              operatorErrorName(error)
            )
          }
        }
      } catch (error) {
        if (publication) {
          try {
            await this.transport.releasePublication(publication.groupIds)
          } catch {
            // Rollback storage failure must not mask the original cancellation failure.
          }
        }
        throw error
      }

      if (!publication) return { submittedTransactions }
      try {
        const publicationResult = await publication.publish(
          this.safeObserver(parameters.onTransactionSubmitted)
        )
        if (publicationResult && typeof publicationResult !== 'string') {
          submittedTransactions.push(...publicationResult)
        } else if (publicationResult) {
          submittedTransactions.push({ operation: 'publish', txHash: publicationResult })
        }
      } catch (error) {
        if (
          error instanceof LadderAdapterError &&
          ['transaction-reverted', 'ratifier-transaction-reverted'].includes(error.operation)
        ) {
          try {
            await this.transport.releasePublication(publication.groupIds)
          } catch {
            // Rollback storage failure must not mask the original publication failure.
          }
        }
        throw error
      }
      await this.transport.confirmPublication(publication.groupIds)
      return { submittedTransactions } satisfies LadderMakeResult
    })
  }

  /**
   * Invalidates every currently active strategy-owned ladder group.
   * @param parameters - Stable application halt reason.
   * @returns Completion after all groups are attempted.
   * @throws `LadderHardHaltError` when one or more cancellations fail.
   */
  hardHalt(parameters: Parameters<LadderMakeService['hardHalt']>[0]) {
    return this.enqueue(() => this.invalidateOwnedGroups(parameters.onTransactionSubmitted))
  }

  /**
   * Invalidates every currently active strategy-owned ladder group during graceful shutdown.
   * @param parameters - Optional observer notified after each cancellation receives its hash.
   * @returns Confirmed cancellation hashes in submission order.
   * @throws `LadderHardHaltError` after every group is attempted when any cancellation fails.
   * @remarks Cleanup enters the same singleton mutation queue as normal ladder reconciliation.
   */
  cleanup(
    parameters: {
      onTransactionSubmitted?: LadderTransactionSubmittedObserver
    } = {}
  ) {
    return this.enqueue(() => this.invalidateOwnedGroups(parameters.onTransactionSubmitted))
  }

  private async invalidateOwnedGroups(
    onTransactionSubmitted?: LadderTransactionSubmittedObserver
  ): Promise<LadderMakeResult> {
    const failures = []
    const submittedTransactions: LadderSubmittedTransaction[] = []
    const ownedGroups = [
      ...new Map(
        (await this.transport.listOwnedGroups()).map(group => [group.groupId, group])
      ).values()
    ]
    for (const { groupId, maxAssets } of ownedGroups) {
      if (this.confirmedCanceledGroups.has(groupId)) continue
      try {
        if ((await this.transport.readGroupConsumed(groupId)) >= maxAssets) {
          await this.transport.forgetGroups([groupId])
          continue
        }
        const txHash = await this.transport.invalidate(
          groupId,
          this.safeObserver(onTransactionSubmitted)
        )
        if (txHash) submittedTransactions.push({ operation: 'cancel', txHash })
        this.confirmedCanceledGroups.add(groupId)
        await this.transport.forgetGroups([groupId])
      } catch (error) {
        try {
          if ((await this.transport.readGroupConsumed(groupId)) >= maxAssets) {
            await this.transport.forgetGroups([groupId])
            continue
          }
        } catch {
          // Preserve the original cancellation failure classification.
        }
        failures.push({ groupId, errorName: operatorErrorName(error) })
      }
    }
    if (failures.length > 0) throw new LadderHardHaltError(failures)
    return { submittedTransactions }
  }

  private safeObserver(
    observer?: LadderTransactionSubmittedObserver
  ): LadderTransactionSubmittedObserver | undefined {
    if (!observer) return undefined
    return async transaction => {
      try {
        await observer(transaction)
      } catch {
        // Diagnostic output must not interrupt receipt handling for an already-submitted transaction.
      }
    }
  }

  private enqueue<Result>(job: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(job, job)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
