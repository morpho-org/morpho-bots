import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import type { LadderMakeService } from '../../application/ladder/ladder-quoter.service'
import type {
  LadderBookReconciliation,
  LadderGroupConsumption,
  LadderMakeResult,
  LadderSubmittedTransaction,
  LadderTransactionSubmittedObserver
} from '../../application/ladder/ladder-verbose'
import type { OwnedOverlapBookOffer } from '../../domain/intentional-overlap'
import type { LadderQuoteSet, LadderWithdrawnSide } from '../../domain/ladder'
import type { OfferCap } from '../../domain/offer-cap'
import type { ExposureAdmission, PublicationWithheld } from '../exposure/exposure-admission.utils'
import type { QuoterConfirmedTransaction } from '../transaction/quoter-transaction-executor'
import type { LadderGroupReference } from './ladder-group-ownership.utils'

import { LadderOwnershipCleanupError } from '../../application/ladder/ladder-ownership-cleanup.error'
import { operatorErrorName } from '../../application/monitoring/operator-error-name.utils'
import { isGroupClosed } from '../../domain/offer-cap'
import { snapshotUnavailable, withheldByAdmission } from '../exposure/exposure-admission.utils'
import { minimumBlockAfter } from '../exposure/exposure-snapshot.utils'
import { LadderAdapterError } from './ladder-adapter.error'
import { hasClearableCrossing } from './ladder-cross-book.utils'
import { LadderHardHaltError } from './ladder-hard-halt.error'
import { assertLadderProspectiveSpread } from './ladder-spread.utils'

type LadderBookOffer = OwnedOverlapBookOffer
type LadderOwnedGroup = { groupId: Hex; cap: OfferCap; buy: boolean }

const LADDER_SIDES = ['lower', 'higher'] as const

/**
 * Market and block state one in-queue read produced, carried between the book assessment and the
 * publication it gates so both resolve ticks against the same instant.
 */
export type LadderObservedMarket = { market: IMarket; now: bigint }

/** The book snapshot and replaced groups one reconciliation cycle works against. */
export type LadderObservedBook = {
  book: readonly LadderBookOffer[]
  replacedGroupIds: ReadonlySet<Hex>
}

/** Blocking transport used by the serialized ladder make adapter. */
export interface LadderOfferTransport {
  /** Reconstructs active quote semantics. @param marketId - Selected market. @returns Active quote set or no quote. */
  readActive(marketId: Hex): Promise<LadderQuoteSet | undefined>
  /** Reads the active quote and its groups' consumption from one snapshot. @param marketId - Selected market. @returns Active quote and indexed owned group consumption. */
  readActiveState(
    marketId: Hex
  ): Promise<{ quote?: LadderQuoteSet; consumption: readonly LadderGroupConsumption[] }>
  /** Lists every durably owned group and its exact consumption cap. @returns Groups used for exhaustive cleanup. */
  listOwnedGroups(): Promise<readonly LadderOwnedGroup[]>
  /** Lists one market's durably owned buy groups and their exact consumption caps. @param marketId - Selected market. @returns Higher-side groups, reserved or confirmed. */
  listOwnedBuyGroups(marketId: Hex): Promise<readonly LadderOwnedGroup[]>
  /** Reads authoritative onchain consumption. @param groupId - Strategy-owned group. @returns Current consumed assets. */
  readGroupConsumed(groupId: Hex): Promise<bigint>
  /** Lists active owned group IDs, optionally for one market. @param marketId - Optional market filter. @returns Distinct group IDs. */
  listActiveGroupIds(marketId?: Hex): Promise<readonly Hex[]>
  /** Lists the maker's live offers for one market. @param marketId - Market being reconciled. @returns Every offer needed for spread safety. */
  listBookOffers(marketId: Hex): Promise<readonly LadderBookOffer[]>
  /**
   * Re-evaluates the resting-ladder crossing and its feasibility from one fresh book read and the
   * current block.
   * @param marketId - Market being reconciled.
   * @param observed - The book snapshot and replaced groups this cycle reconciles against.
   * @returns The rechecked per-side crossing, and the market/block state it read so the publication
   * this gates can start its offers at the timestamp reported here.
   * @throws When the market is unconfigured, already matured, or its state cannot be read.
   */
  assessBook(
    marketId: Hex,
    observed: LadderObservedBook
  ): Promise<{
    reconciliation: Omit<LadderBookReconciliation, 'applied'>
    observedMarket: LadderObservedMarket
  }>
  /**
   * Prepares a policy-checked desired tree without broadcasting it.
   * @param quote - Exact desired quote set.
   * @param observed - The book snapshot and replaced groups this cycle reconciles against, plus the
   * market/block state {@link LadderOfferTransport.assessBook} already read.
   * @returns Publication metadata and one-shot ratifier/publisher, or `undefined` when nothing in
   * `quote` is publishable at the observed block, which withdraws the ladder.
   * @remarks `observed` must be the same snapshot the caller then passes to
   * `assertLadderProspectiveSpread`. Preparation clears the opposing offers it names, so a
   * different snapshot would let preparation clear one book while the guard checks another.
   */
  preparePublication(
    quote: LadderQuoteSet,
    observed: LadderObservedBook & { observedMarket?: LadderObservedMarket }
  ): Promise<
    | {
        groupIds: readonly Hex[]
        groups: readonly LadderGroupReference[]
        prospective: readonly LadderBookOffer[]
        /** Rungs per side the opposing book repriced while clearing the publication. */
        bookClearedRungs: { lower: number; higher: number }
        /** Sides of `quote` the publication leaves out; see {@link LadderWithdrawnSide}. */
        withdrawnSides?: readonly LadderWithdrawnSide[]
        /**
         * Ratifies when required, publishes the policy-checked tree, and waits for every receipt.
         * @param onTransactionSubmitted - Optional safe observer notified after each wallet submission.
         * @returns Confirmed ratification and publication transactions in submission order.
         */
        publish(
          onTransactionSubmitted?: LadderTransactionSubmittedObserver
        ): Promise<Hex | void | readonly LadderSubmittedTransaction[]>
      }
    | undefined
  >
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
  /**
   * Checks a reserved publication's buy side against a fresh exposure snapshot.
   * @param candidate - Market, desired quote, the publication's own groups, and the block every
   * replaced group's cancellation landed in.
   * @returns Whether the higher-side buys still fit every configured limit and the market's
   * accepted loss factor.
   * @throws When no snapshot at or after `minimumBlockNumber` can be read.
   */
  admitPublication(candidate: {
    marketId: Hex
    quote: LadderQuoteSet
    groupIds: readonly Hex[]
    minimumBlockNumber?: bigint
  }): Promise<ExposureAdmission>
  /** Invalidates one active owned group. @param groupId - Protocol group ID. @param onTransactionSubmitted - Optional safe observer notified after wallet submission. @returns Canonical transaction hash and receipt block after confirmation. */
  invalidate(
    groupId: Hex,
    onTransactionSubmitted?: LadderTransactionSubmittedObserver
  ): Promise<QuoterConfirmedTransaction | void>
  /**
   * Invalidates every listed group in one native Midnight multicall.
   * @param groupIds - Ordered distinct group IDs cancelled together.
   * @param onTransactionSubmitted - Optional safe observer notified once after wallet submission.
   * @returns The shared canonical transaction hash and receipt block after confirmation.
   * @throws An adapter error when policy validation, submission, or receipt confirmation fails.
   */
  invalidateBatch(
    groupIds: readonly Hex[],
    onTransactionSubmitted?: LadderTransactionSubmittedObserver
  ): Promise<QuoterConfirmedTransaction | void>
  /** Removes canceled groups from durable ownership. @param groupIds - Successfully canceled IDs. @returns Completion after atomic storage. */
  forgetGroups(groupIds: readonly Hex[]): Promise<void>
}

/** Serialized live adapter for ladder publication, replacement, and safety cleanup. */
export class MidnightLadderMakeService implements LadderMakeService {
  private queue = Promise.resolve()
  private readonly confirmedCanceledGroups = new Set<Hex>()

  /** Creates one mutation queue. @param transport - Protocol, book, and ownership transport. @param maker - Configured maker whose offers the spread guard treats as own. */
  constructor(
    private readonly transport: LadderOfferTransport,
    private readonly maker: Address
  ) {}

  /** Reads active quote state. @param marketId - Selected market. @returns Reconstructed quote or no active quote. */
  readActive(marketId: Hex) {
    return this.transport.readActive(marketId)
  }

  /**
   * Reads the active quote and its groups' consumption from one snapshot.
   * @param marketId - Selected market.
   * @returns Active quote when roots remain live, plus indexed owned group consumption.
   * @throws When active roots or indexed group state cannot be read.
   * @remarks Observation-only for the consumption half: it takes no mutation queue slot and never
   * changes publication state. One read backs both values so monitoring adds no round trip.
   */
  readActiveState(marketId: Hex) {
    return this.transport.readActiveState(marketId)
  }

  /**
   * Reconciles one quote set inside the singleton mutation queue.
   * @param parameters - Selected market, desired quote, and audited reason.
   * @returns Completion after every required receipt and ownership update.
   * @throws When preparation, spread validation, cancellation, publication, or storage fails.
   * @remarks The future groups are reserved before old groups are invalidated. A publication whose
   * submission outcome is unknown remains reserved so a restart still recognizes it as owned. The
   * crossing that upgraded a `rest` into a `book-crossed` replacement is rechecked here against a
   * fresh book, before anything is reserved, cancelled, or signed. After the cancellations confirm,
   * the buy side is re-admitted against a snapshot at or after their receipts, since an old buy can
   * fill until its cancellation lands; a publication that no longer fits is released unpublished
   * and reported as `publicationWithheld`. Two or more replaced groups share one native Midnight
   * multicall; a lone group uses one `setConsumed` call.
   */
  reconcile(parameters: Parameters<LadderMakeService['reconcile']>[0]) {
    // oxlint-disable-next-line complexity
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
      const book = parameters.desired
        ? await this.transport.listBookOffers(parameters.marketId)
        : undefined
      const observed =
        parameters.desired && book ? { book, replacedGroupIds: spreadReplacedGroupIds } : undefined
      const assessed = observed
        ? await this.transport.assessBook(parameters.marketId, observed)
        : undefined
      // A `book-crossed` request without an assessed publication would otherwise fall through to
      // cancelling the ladder with nothing to republish, so absence fails closed here too.
      if (
        parameters.reason === 'book-crossed' &&
        !(
          assessed &&
          hasClearableCrossing(assessed.reconciliation.bookCrossing, parameters.bookCrossedSides)
        )
      ) {
        return {
          submittedTransactions,
          ...(assessed ? { reconciliation: { ...assessed.reconciliation, applied: false } } : {})
        }
      }
      const publication =
        parameters.desired && observed && assessed
          ? await this.transport.preparePublication(parameters.desired, {
              ...observed,
              observedMarket: assessed.observedMarket
            })
          : undefined
      const withdrawnSides =
        parameters.desired && assessed
          ? publication
            ? (publication.withdrawnSides ?? [])
            : LADDER_SIDES.filter(side => parameters.desired![side].length > 0)
          : []
      const withdrawn = withdrawnSides.length === 0 ? {} : { withdrawnSides }
      const publishedQuote = parameters.desired && {
        ...parameters.desired,
        lower: withdrawnSides.includes('lower') ? [] : parameters.desired.lower,
        higher: withdrawnSides.includes('higher') ? [] : parameters.desired.higher
      }
      if (publication && book) {
        assertLadderProspectiveSpread({
          marketId: parameters.marketId,
          maker: this.maker,
          replacedGroupIds: spreadReplacedGroupIds,
          book,
          prospective: publication.prospective
        })
        await this.transport.reservePublication({
          marketId: parameters.marketId,
          quote: publishedQuote!,
          groups: publication.groups
        })
      }

      const cancellationBlocks: bigint[] = []
      try {
        const groupIds = [...invalidatedGroupIds]
        if (groupIds.length > 0) {
          const observer = this.safeObserver(parameters.onTransactionSubmitted)
          const confirmed =
            groupIds.length === 1
              ? await this.transport.invalidate(groupIds[0]!, observer)
              : await this.transport.invalidateBatch(groupIds, observer)
          if (confirmed) {
            submittedTransactions.push({ operation: 'cancel', txHash: confirmed.txHash })
            cancellationBlocks.push(confirmed.blockNumber)
          }
          for (const groupId of groupIds) this.confirmedCanceledGroups.add(groupId)
          try {
            await this.transport.forgetGroups(groupIds)
          } catch (error) {
            throw new LadderOwnershipCleanupError(
              groupIds[0]!,
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

      const reconciliation = assessed
        ? { reconciliation: { ...assessed.reconciliation, applied: true } }
        : {}
      if (!publication) return { submittedTransactions, ...reconciliation, ...withdrawn }
      const publicationWithheld = await this.admit({
        marketId: parameters.marketId,
        quote: publishedQuote!,
        groupIds: publication.groupIds,
        ...minimumBlockAfter(cancellationBlocks)
      })
      if (publicationWithheld) {
        try {
          await this.transport.releasePublication(publication.groupIds)
        } catch {
          throw new LadderAdapterError(
            'publication-reservation-cleanup'
          ).recordConfirmedTransactions(submittedTransactions)
        }
        return { submittedTransactions, publicationWithheld, ...reconciliation, ...withdrawn }
      }
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
      return {
        submittedTransactions,
        bookClearedRungs: publication.bookClearedRungs,
        ...reconciliation,
        ...withdrawn
      } satisfies LadderMakeResult
    })
  }

  /**
   * Cancels every unconsumed owned buy group of one market inside the singleton mutation queue.
   * @param parameters - Market, stable reason, and optional submission observer.
   * @returns The confirmed batched cancellation, or no transaction when no buy remains live.
   * @throws When consumption cannot be read or the batched cancellation is not confirmed, keeping
   * ownership; `LadderOwnershipCleanupError` when the confirmed cancellation cannot be forgotten.
   * @remarks A group consumed up to its cap holds no buy and is left as is. Sell groups are never
   * read or touched.
   */
  cancelBuys(parameters: Parameters<LadderMakeService['cancelBuys']>[0]) {
    return this.enqueue(async (): Promise<LadderMakeResult> => {
      const submittedTransactions: LadderSubmittedTransaction[] = []
      const pendingGroupIds: Hex[] = []
      for (const group of await this.transport.listOwnedBuyGroups(parameters.marketId)) {
        if (this.confirmedCanceledGroups.has(group.groupId)) continue
        if (isGroupClosed(group, await this.transport.readGroupConsumed(group.groupId))) continue
        pendingGroupIds.push(group.groupId)
      }
      if (pendingGroupIds.length === 0) return { submittedTransactions }
      const confirmed = await this.transport.invalidateBatch(
        pendingGroupIds,
        this.safeObserver(parameters.onTransactionSubmitted)
      )
      if (confirmed) submittedTransactions.push({ operation: 'cancel', txHash: confirmed.txHash })
      for (const groupId of pendingGroupIds) this.confirmedCanceledGroups.add(groupId)
      try {
        await this.transport.forgetGroups(pendingGroupIds)
      } catch (error) {
        throw new LadderOwnershipCleanupError(
          pendingGroupIds[0]!,
          [...submittedTransactions],
          operatorErrorName(error)
        )
      }
      return { submittedTransactions }
    })
  }

  /**
   * Invalidates every currently active strategy-owned ladder group.
   * @param parameters - Stable application halt reason.
   * @returns Completion after all groups are attempted.
   * @throws `LadderHardHaltError` when the batched cancellation fails.
   * @remarks All groups still requiring cancellation share one native Midnight multicall.
   */
  hardHalt(parameters: Parameters<LadderMakeService['hardHalt']>[0]) {
    return this.enqueue(() => this.invalidateOwnedGroups(parameters.onTransactionSubmitted))
  }

  /**
   * Invalidates every currently active strategy-owned ladder group during graceful shutdown.
   * @param parameters - Optional observer notified when the batched cancellation receives its hash.
   * @returns The confirmed cancellation hash shared by every cancelled group.
   * @throws `LadderHardHaltError` when the batched cancellation or ownership cleanup fails.
   * @remarks Cleanup enters the same singleton mutation queue as normal ladder reconciliation. All
   * groups still requiring cancellation share one native Midnight multicall.
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
    const pendingGroups: LadderOwnedGroup[] = []
    for (const group of ownedGroups) {
      const { groupId } = group
      if (this.confirmedCanceledGroups.has(groupId)) continue
      try {
        if (isGroupClosed(group, await this.transport.readGroupConsumed(groupId))) {
          await this.transport.forgetGroups([groupId])
          continue
        }
        pendingGroups.push(group)
      } catch (error) {
        failures.push({ groupId, errorName: operatorErrorName(error) })
      }
    }
    if (pendingGroups.length > 0) {
      const pendingGroupIds = pendingGroups.map(group => group.groupId)
      try {
        const confirmed = await this.transport.invalidateBatch(
          pendingGroupIds,
          this.safeObserver(onTransactionSubmitted)
        )
        if (confirmed) submittedTransactions.push({ operation: 'cancel', txHash: confirmed.txHash })
        for (const groupId of pendingGroupIds) this.confirmedCanceledGroups.add(groupId)
        await this.transport.forgetGroups(pendingGroupIds)
      } catch (error) {
        failures.push(...(await this.batchCancellationFailures(pendingGroups, error)))
      }
    }
    if (failures.length > 0) throw new LadderHardHaltError(failures)
    return { submittedTransactions }
  }

  private async batchCancellationFailures(
    pendingGroups: readonly LadderOwnedGroup[],
    error: unknown
  ): Promise<{ groupId: Hex; errorName: string }[]> {
    const failures: { groupId: Hex; errorName: string }[] = []
    for (const group of pendingGroups) {
      const { groupId } = group
      try {
        if (isGroupClosed(group, await this.transport.readGroupConsumed(groupId))) {
          await this.transport.forgetGroups([groupId])
          continue
        }
      } catch {
        // Preserve the original cancellation failure classification.
      }
      failures.push({ groupId, errorName: operatorErrorName(error) })
    }
    return failures
  }

  private async admit(
    candidate: Parameters<LadderOfferTransport['admitPublication']>[0]
  ): Promise<PublicationWithheld | undefined> {
    if (candidate.quote.higher.length === 0) return undefined
    try {
      return withheldByAdmission(await this.transport.admitPublication(candidate))
    } catch (error) {
      return snapshotUnavailable(error)
    }
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
