import type { Hex } from 'viem'

import { MathLib } from '@morpho-org/morpho-ts'

import type {
  BootstrapMakeResult,
  BootstrapSubmittedTransaction,
  BootstrapTransactionSubmittedObserver
} from '../../application/bootstrap/position-bootstrap-verbose'
import type { BootstrapMakeService } from '../../application/bootstrap/position-bootstrap.service'
import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { ExposureAdmission, PublicationWithheld } from '../exposure/exposure-admission.utils'
import type { QuoterConfirmedTransaction } from '../transaction/quoter-transaction-executor'
import type { BootstrapCrossBookOffer } from './bootstrap-cross-book.utils'
import type { BootstrapActiveGroup } from './bootstrap-position.service'

import { BootstrapOwnershipCleanupError } from '../../application/bootstrap/bootstrap-ownership-cleanup.error'
import { operatorErrorName } from '../../application/monitoring/operator-error-name.utils'
import { isAprWadInRange } from '../../domain/tick-window'
import { snapshotUnavailable, withheldByAdmission } from '../exposure/exposure-admission.utils'
import { minimumBlockAfter } from '../exposure/exposure-snapshot.utils'
import { BootstrapAdapterError } from './bootstrap-adapter.error'
import { resolveBootstrapProspectiveOffer } from './bootstrap-cross-book.utils'
import { BootstrapHardHaltError } from './bootstrap-hard-halt.error'
import { bootstrapMarketGroupIds } from './bootstrap-spread.utils'

type BootstrapBookOffer = BootstrapCrossBookOffer

const BPS_WAD = MathLib.WAD / 10_000n

/** Protocol transport for confirmed Midnight publication and group invalidation. */
interface BootstrapOfferTransport {
  /** Reads configured bootstrap rate bounds. @param marketId - Selected market. @returns Inclusive hard rate bounds. */
  rateBounds?(marketId: Hex): { minimumRateBps: bigint; maximumRateBps: bigint } | undefined
  /** Lists active strategy groups from Mempool truth. @returns Current active group projections. */
  listActiveGroups(): Promise<readonly BootstrapActiveGroup[]>
  /** Lists explicitly owned groups that are not conclusively canceled. @returns Group IDs requiring exhaustive cleanup. */
  listOwnedGroupIds?(): Promise<readonly Hex[]>
  /** Lists the maker's current book for one market. @param marketId - Market being reconciled. @returns Every active offer needed for spread safety. */
  listBookOffers(marketId: Hex): Promise<readonly BootstrapBookOffer[]>
  /** Projects a domain offer into its exact protocol tick. @param offer - Desired offer. @param exactTick - Exact tick overriding rate derivation during cross-book repricing. @returns Prospective book offer. */
  toProspectiveBookOffer(offer: BootstrapOffer, exactTick?: bigint): Promise<BootstrapBookOffer>
  /** Prepares one policy-checked publication without broadcasting it. @param offer - Desired offer. @returns Reserved group ID and a one-shot confirmed ratifier/publisher. */
  preparePublication(offer: BootstrapOffer): Promise<{
    groupId: Hex
    tick?: bigint
    publish(
      onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
    ): Promise<Hex | void | readonly BootstrapSubmittedTransaction[]>
  }>
  /** Durably records publication intent before broadcast. @param group - Future group ID. @returns Completion after durable storage. */
  reserveGroup(
    group: Hex,
    offer: BootstrapOffer & { tick?: bigint; continuousFeeCap?: bigint }
  ): Promise<void>
  /** Finalizes a confirmed group while retaining ownership. @param group - Confirmed group ID. @returns Completion after durable storage. */
  confirmPublishedGroup(group: Hex): Promise<void>
  /** Removes intent after publication fails. @param group - Unpublished group ID. @returns Completion after durable storage. */
  releaseGroupReservation(group: Hex): Promise<void>
  /**
   * Checks a reserved publication against a fresh exposure snapshot.
   * @param candidate - Market, the publication's own group, its assets, and the block every
   * replaced group's cancellation landed in.
   * @returns Whether the offer still fits every configured limit and the market's accepted loss
   * factor.
   * @throws When no snapshot at or after `minimumBlockNumber` can be read.
   */
  admitPublication(candidate: {
    marketId: Hex
    groupId: Hex
    assets: bigint
    minimumBlockNumber?: bigint
  }): Promise<ExposureAdmission>
  /** Removes confirmed canceled groups from durable ownership. @param groups - Canceled group IDs. @returns Completion after durable storage; configured IDs remain configuration-owned. */
  forgetGroups?(groups: readonly Hex[]): Promise<void>
  /** Invalidates one active group onchain. @param group - Active group ID. @returns Canonical transaction hash and receipt block after confirmation. */
  invalidate(
    group: Hex,
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  ): Promise<QuoterConfirmedTransaction | void>
  /**
   * Invalidates every listed group in one native Midnight multicall.
   * @param groups - Ordered distinct group IDs cancelled together.
   * @param onTransactionSubmitted - Optional observer notified once after wallet submission.
   * @returns The shared canonical transaction hash and receipt block after confirmation.
   * @throws An adapter error when policy validation, submission, or receipt confirmation fails.
   */
  invalidateBatch(
    groups: readonly Hex[],
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  ): Promise<QuoterConfirmedTransaction | void>
}

/** Serialized production adapter for one-cycle bootstrap publication and hard halts. */
export class MidnightBootstrapMakeService implements BootstrapMakeService {
  private queue = Promise.resolve()
  private readonly confirmedCanceledGroups = new Set<Hex>()

  /** Creates a singleton mutation queue. @param transport - Midnight SDK transport. */
  constructor(private readonly transport: BootstrapOfferTransport) {}

  /**
   * Reconciles one market after reloading Mempool truth inside the mutation queue.
   * @param parameters - Market, desired lend offer, and audited decision reason.
   * @returns Confirmed cancellation and publication transaction hashes in submission order.
   * @throws When any protocol mutation or confirmation fails.
   * @remarks Mutations are serialized; publication never races invalidation. An active offer with
   * the requested protocol tick, assets, and continuous-fee cap is retained even when raw
   * reference-rate metadata moved. A new publication is re-admitted against a snapshot at or after
   * every replaced group's cancellation receipt; one that no longer fits is released unpublished
   * and reported as `publicationWithheld`.
   */
  reconcile(parameters: {
    marketId: Hex
    desiredOffer?: BootstrapOffer
    maximumAssets?: bigint
    minimumRateBps?: bigint
    maximumRateBps?: bigint
    reason:
      | 'publish'
      | 'replace'
      | 'target-reached'
      | 'no-capacity'
      | 'rate-out-of-range'
      | 'auto-refill-disabled'
      | 'loss-factor-mismatch'
      | 'market-read-failed'
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  }) {
    // oxlint-disable-next-line complexity
    return this.enqueue(async () => {
      const submittedTransactions: BootstrapSubmittedTransaction[] = []
      const groups = await this.strategyGroups()
      const activeMarketGroupIds = new Set(bootstrapMarketGroupIds(groups, parameters.marketId))
      let publication:
        | Awaited<ReturnType<BootstrapOfferTransport['preparePublication']>>
        | undefined
      let retainedGroup: BootstrapActiveGroup | undefined
      let resolvedOffer: BootstrapOffer | undefined
      if (parameters.desiredOffer) {
        const [book, durableOwnedGroupIds, prospective] = await Promise.all([
          this.transport.listBookOffers(parameters.marketId),
          this.transport.listOwnedGroupIds?.() ?? Promise.resolve([]),
          this.transport.toProspectiveBookOffer(parameters.desiredOffer)
        ])
        const spreadReplacedGroupIds = new Set([
          ...activeMarketGroupIds,
          ...durableOwnedGroupIds,
          ...this.confirmedCanceledGroups
        ])
        const configuredBounds = this.transport.rateBounds?.(parameters.marketId)
        const minimumRateBps =
          parameters.minimumRateBps ??
          configuredBounds?.minimumRateBps ??
          parameters.desiredOffer.rateBps
        const maximumRateBps =
          parameters.maximumRateBps ??
          configuredBounds?.maximumRateBps ??
          parameters.desiredOffer.rateBps
        const resolved = await resolveBootstrapProspectiveOffer({
          desiredOffer: parameters.desiredOffer,
          prospective,
          replacedGroupIds: spreadReplacedGroupIds,
          book,
          minimumRateBps,
          maximumRateBps,
          toProspectiveBookOffer: (offer, exactTick) =>
            this.transport.toProspectiveBookOffer(offer, exactTick)
        })
        if (resolved) {
          const cappedOffer =
            parameters.maximumAssets !== undefined &&
            resolved.offer.assets > parameters.maximumAssets
              ? { ...resolved.offer, assets: parameters.maximumAssets }
              : resolved.offer
          const publicationProspective =
            cappedOffer === resolved.offer
              ? resolved.prospective
              : await this.transport.toProspectiveBookOffer(cappedOffer, resolved.prospective.tick)
          const publicationRateWad =
            publicationProspective.effectiveRateWad ?? cappedOffer.rateBps * BPS_WAD
          if (!isAprWadInRange(publicationRateWad, { minimumRateBps, maximumRateBps })) {
            throw new BootstrapAdapterError('negative-spread')
          }
          resolvedOffer = cappedOffer
          retainedGroup = groups.find(
            group =>
              group.marketId === parameters.marketId &&
              group.assets === cappedOffer.assets &&
              group.tick === publicationProspective.tick &&
              group.offerCount === 1 &&
              group.continuousFeeCap !== undefined &&
              group.continuousFeeCap === publicationProspective.continuousFeeCap &&
              !this.confirmedCanceledGroups.has(group.id)
          )
          if (!retainedGroup) {
            publication = await this.transport.preparePublication(cappedOffer)
            await this.transport.reserveGroup(publication.groupId, {
              ...cappedOffer,
              ...(publication.tick === undefined ? {} : { tick: publication.tick }),
              ...(publicationProspective.continuousFeeCap === undefined
                ? {}
                : { continuousFeeCap: publicationProspective.continuousFeeCap })
            })
          }
        }
      }
      const invalidatedGroupIds = new Set(
        [...activeMarketGroupIds].filter(
          groupId => groupId !== retainedGroup?.id && !this.confirmedCanceledGroups.has(groupId)
        )
      )
      const cancellationBlocks: bigint[] = []
      try {
        await this.cancelThenForget(
          [...invalidatedGroupIds],
          submittedTransactions,
          cancellationBlocks,
          parameters.onTransactionSubmitted
        )
      } catch (error) {
        if (publication) {
          try {
            await this.transport.releaseGroupReservation(publication.groupId)
          } catch (cleanupError) {
            // oxlint-disable-next-line max-depth
            if (error instanceof BootstrapAdapterError) {
              error.recordReservationCleanupFailure(operatorErrorName(cleanupError))
            }
          }
        }
        throw error
      }
      if (retainedGroup && resolvedOffer) {
        try {
          await this.transport.reserveGroup(retainedGroup.id, {
            ...resolvedOffer,
            assets: retainedGroup.maximumAssets ?? retainedGroup.assets,
            ...(retainedGroup.tick === undefined ? {} : { tick: retainedGroup.tick }),
            ...(retainedGroup.continuousFeeCap === undefined
              ? {}
              : { continuousFeeCap: retainedGroup.continuousFeeCap })
          })
          await this.transport.confirmPublishedGroup(retainedGroup.id)
        } catch (error) {
          const failure =
            error instanceof BootstrapAdapterError
              ? error
              : new BootstrapAdapterError('retained-group-metadata-refresh')
          throw failure.recordConfirmedTransactions(submittedTransactions)
        }

        return submittedTransactions.length === 0
          ? ('unchanged' as const)
          : ({ submittedTransactions } satisfies BootstrapMakeResult)
      }
      if (publication && resolvedOffer) {
        const publicationWithheld = await this.admit({
          marketId: parameters.marketId,
          groupId: publication.groupId,
          assets: resolvedOffer.assets,
          ...minimumBlockAfter(cancellationBlocks)
        })
        if (publicationWithheld) {
          try {
            await this.transport.releaseGroupReservation(publication.groupId)
          } catch (cleanupError) {
            throw new BootstrapAdapterError('publication-reservation-cleanup')
              .recordReservationCleanupFailure(operatorErrorName(cleanupError))
              .recordConfirmedTransactions(submittedTransactions)
          }
          return { submittedTransactions, publicationWithheld } satisfies BootstrapMakeResult
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
            error instanceof BootstrapAdapterError &&
            ['transaction-reverted', 'ratifier-transaction-reverted'].includes(error.operation)
          ) {
            // oxlint-disable-next-line max-depth
            try {
              await this.transport.releaseGroupReservation(publication.groupId)
            } catch {
              throw new BootstrapAdapterError('publication-reservation-cleanup')
            }
          }
          throw error
        }
        await this.transport.confirmPublishedGroup(publication.groupId)
      }
      return { submittedTransactions } satisfies BootstrapMakeResult
    })
  }

  /**
   * Resolves the exact offer used by cross-market reservation planning without mutating protocol state.
   * @param parameters - Desired offer and configured inclusive rate bounds.
   * @returns Adjusted offer, or `undefined` when the owned ladder sell covers it completely.
   * @throws `BootstrapAdapterError` when current book or ownership evidence cannot prove safety.
   * @remarks Independent book, ownership, and projection reads run concurrently after active groups
   * are loaded; no reservation, cancellation, publication, or durable ownership write occurs.
   */
  async preview(parameters: Parameters<NonNullable<BootstrapMakeService['preview']>>[0]) {
    const groups = await this.strategyGroups()
    const [book, durableOwnedGroupIds, prospective] = await Promise.all([
      this.transport.listBookOffers(parameters.marketId),
      this.transport.listOwnedGroupIds?.() ?? Promise.resolve([]),
      this.transport.toProspectiveBookOffer(parameters.desiredOffer)
    ])
    const replacedGroupIds = new Set([
      ...bootstrapMarketGroupIds(groups, parameters.marketId),
      ...durableOwnedGroupIds,
      ...this.confirmedCanceledGroups
    ])
    return (
      await resolveBootstrapProspectiveOffer({
        desiredOffer: parameters.desiredOffer,
        prospective,
        replacedGroupIds,
        book,
        minimumRateBps: parameters.minimumRateBps,
        maximumRateBps: parameters.maximumRateBps,
        toProspectiveBookOffer: (offer, exactTick) =>
          this.transport.toProspectiveBookOffer(offer, exactTick)
      })
    )?.offer
  }

  /**
   * Invalidates every currently re-derived strategy bootstrap group in one batch.
   * @param parameters - Stable strategy-wide halt reason.
   * @returns Confirmed cancellation transaction hashes in submission order.
   * @throws When listing the groups or the batched cancellation fails.
   * @remarks All groups still requiring cancellation share one native Midnight multicall.
   */
  hardHalt(parameters: {
    reason: 'reference-read-failed' | 'bootstrap-decision-failed' | 'market-invalidation-failed'
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  }) {
    void parameters
    return this.enqueue(() => this.invalidateOwnedGroups(parameters.onTransactionSubmitted))
  }

  /**
   * Invalidates every explicitly owned bootstrap group during graceful shutdown.
   * @param parameters - Optional observer notified when the batched cancellation receives its hash.
   * @returns The confirmed cancellation hash shared by every cancelled group.
   * @throws `BootstrapHardHaltError` when the batched cancellation or ownership cleanup fails.
   * @remarks Cleanup enters the same mutation queue as publication and normal reconciliation. All
   * groups still requiring cancellation share one native Midnight multicall.
   */
  cleanup(
    parameters: {
      onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
    } = {}
  ) {
    return this.enqueue(() => this.invalidateOwnedGroups(parameters.onTransactionSubmitted))
  }

  private strategyGroups = async () => {
    return this.transport.listActiveGroups()
  }

  private async invalidateOwnedGroups(
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  ): Promise<BootstrapMakeResult> {
    const submittedTransactions: BootstrapSubmittedTransaction[] = []
    const groupIds = new Set(
      this.transport.listOwnedGroupIds
        ? await this.transport.listOwnedGroupIds()
        : (await this.strategyGroups()).map(group => group.id)
    )
    const pendingGroupIds = [...groupIds].filter(
      groupId => !this.confirmedCanceledGroups.has(groupId)
    )
    if (pendingGroupIds.length === 0) return { submittedTransactions }
    try {
      const confirmed = await this.transport.invalidateBatch(
        pendingGroupIds,
        this.safeObserver(onTransactionSubmitted)
      )
      if (confirmed) submittedTransactions.push({ operation: 'cancel', txHash: confirmed.txHash })
      for (const groupId of pendingGroupIds) this.confirmedCanceledGroups.add(groupId)
      await this.transport.forgetGroups?.(pendingGroupIds)
    } catch (error) {
      throw new BootstrapHardHaltError(
        pendingGroupIds.map(groupId => ({ groupId, errorName: operatorErrorName(error) }))
      )
    }
    return { submittedTransactions }
  }

  /**
   * Cancels every listed group in one transaction before forgetting any, so a failed ownership
   * write can never skip a cancellation.
   * @throws The cancellation failure, with every group still owned; or
   * `BootstrapOwnershipCleanupError` once the cancellation confirmed but forgetting failed.
   * @remarks Two or more groups share one native Midnight multicall; a lone group uses one
   * `setConsumed` call.
   */
  private async cancelThenForget(
    groupIds: readonly Hex[],
    submittedTransactions: BootstrapSubmittedTransaction[],
    cancellationBlocks: bigint[],
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  ) {
    if (groupIds.length === 0) return
    const observer = this.safeObserver(onTransactionSubmitted)
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
      await this.transport.forgetGroups?.(groupIds)
    } catch (error) {
      throw new BootstrapOwnershipCleanupError(
        groupIds[0]!,
        [...submittedTransactions],
        operatorErrorName(error)
      )
    }
  }

  private async admit(
    candidate: Parameters<BootstrapOfferTransport['admitPublication']>[0]
  ): Promise<PublicationWithheld | undefined> {
    try {
      return withheldByAdmission(await this.transport.admitPublication(candidate))
    } catch (error) {
      return snapshotUnavailable(error)
    }
  }

  private safeObserver(
    observer?: BootstrapTransactionSubmittedObserver
  ): BootstrapTransactionSubmittedObserver | undefined {
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
