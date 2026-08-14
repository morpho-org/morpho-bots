import type { Hex } from 'viem'

import type {
  BootstrapMakeResult,
  BootstrapSubmittedTransaction,
  BootstrapTransactionSubmittedObserver
} from '../../application/bootstrap/position-bootstrap-verbose'
import type { BootstrapMakeService } from '../../application/bootstrap/position-bootstrap.service'
import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'
import type { BootstrapOverlapBookOffer } from './bootstrap-overlap.utils'
import type { BootstrapActiveGroup } from './bootstrap-position.service'

import { BootstrapOwnershipCleanupError } from '../../application/bootstrap/bootstrap-ownership-cleanup.error'
import { operatorErrorName } from '../../application/operator-error-name.utils'
import { BootstrapAdapterError } from './bootstrap-adapter.error'
import { BootstrapHardHaltError } from './bootstrap-hard-halt.error'
import { resolveBootstrapProspectiveOffer } from './bootstrap-overlap.utils'
import { bootstrapMarketGroupIds } from './bootstrap-spread.utils'

const BPS_WAD = 100_000_000_000_000n

type BootstrapBookOffer = BootstrapOverlapBookOffer & { continuousFeeCap?: bigint }

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
  /** Projects a domain offer into its exact protocol tick. @param offer - Desired offer. @param exactTick - Existing owned sell tick required for an intentional overlap. @returns Prospective book offer. */
  toProspectiveBookOffer(offer: BootstrapOffer, exactTick?: bigint): Promise<BootstrapBookOffer>
  /** Projects an adjusted buy onto a bounded tick strictly below a crossing sell. @param offer - Nominally adjusted buy. @param maximumExclusiveTick - Crossing sell tick. @param minimumRateBps - Inclusive minimum effective APR. @param maximumRateBps - Inclusive maximum effective APR. @returns Safe prospective book offer with effective rate evidence. */
  toBoundedProspectiveBookOffer?(
    offer: BootstrapOffer,
    maximumExclusiveTick: bigint,
    minimumRateBps: bigint,
    maximumRateBps: bigint
  ): Promise<BootstrapBookOffer>
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
  /** Removes confirmed canceled groups from durable ownership. @param groups - Canceled group IDs. @returns Completion after durable storage; configured IDs remain configuration-owned. */
  forgetGroups?(groups: readonly Hex[]): Promise<void>
  /** Invalidates one active group onchain. @param group - Active group ID. @returns Completion after receipt confirmation. */
  invalidate(
    group: Hex,
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  ): Promise<Hex | void>
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
   * reference-rate metadata moved.
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
      | 'auto-refill-disabled'
      | 'market-read-failed'
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  }) {
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
            this.transport.toProspectiveBookOffer(offer, exactTick),
          ...(this.transport.toBoundedProspectiveBookOffer === undefined
            ? {}
            : {
                toBoundedProspectiveBookOffer: (
                  offer: BootstrapOffer,
                  maximumExclusiveTick: bigint,
                  minimumRate: bigint,
                  maximumRate: bigint
                ) =>
                  this.transport.toBoundedProspectiveBookOffer!(
                    offer,
                    maximumExclusiveTick,
                    minimumRate,
                    maximumRate
                  )
              })
        })
        if (resolved) {
          let cappedOffer =
            parameters.maximumAssets !== undefined &&
            resolved.offer.assets > parameters.maximumAssets
              ? { ...resolved.offer, assets: parameters.maximumAssets }
              : resolved.offer
          let publicationProspective = resolved.prospective
          if (cappedOffer !== resolved.offer) {
            if (
              resolved.maximumExclusiveTick !== undefined &&
              this.transport.toBoundedProspectiveBookOffer !== undefined
            ) {
              publicationProspective = await this.transport.toBoundedProspectiveBookOffer(
                cappedOffer,
                resolved.maximumExclusiveTick,
                minimumRateBps,
                maximumRateBps
              )
              if (
                publicationProspective.effectiveAprWad === undefined ||
                publicationProspective.effectiveRateBps === undefined ||
                publicationProspective.effectiveAprWad < minimumRateBps * BPS_WAD ||
                publicationProspective.effectiveAprWad > maximumRateBps * BPS_WAD
              ) {
                throw new BootstrapAdapterError('negative-spread')
              }
              cappedOffer = {
                ...cappedOffer,
                rateBps: publicationProspective.effectiveRateBps
              }
            } else {
              publicationProspective = await this.transport.toProspectiveBookOffer(
                cappedOffer,
                resolved.prospective.tick
              )
            }
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
            await this.transport.forgetGroups?.([groupId])
          } catch (error) {
            throw new BootstrapOwnershipCleanupError(
              groupId,
              [...submittedTransactions],
              operatorErrorName(error)
            )
          }
        }
      } catch (error) {
        if (publication) {
          try {
            await this.transport.releaseGroupReservation(publication.groupId)
          } catch (cleanupError) {
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
      if (publication) {
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
   * Invalidates every currently re-derived strategy bootstrap group serially.
   * @param parameters - Stable strategy-wide halt reason.
   * @returns Confirmed cancellation transaction hashes in submission order.
   * @throws When listing or invalidating any group fails.
   */
  hardHalt(parameters: {
    reason:
      | 'reference-read-failed'
      | 'bootstrap-decision-failed'
      | 'bootstrap-configuration-failed'
      | 'market-invalidation-failed'
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  }) {
    void parameters
    return this.enqueue(() => this.invalidateOwnedGroups(parameters.onTransactionSubmitted))
  }

  /**
   * Invalidates every explicitly owned bootstrap group during graceful shutdown.
   * @param parameters - Optional observer notified as each cancellation receives its hash.
   * @returns Confirmed cancellation transaction hashes in submission order.
   * @throws `BootstrapHardHaltError` after all groups are attempted when any cancellation fails.
   * @remarks Cleanup enters the same mutation queue as publication and normal reconciliation.
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
    const failures = []
    const submittedTransactions: BootstrapSubmittedTransaction[] = []
    const groupIds = new Set(
      this.transport.listOwnedGroupIds
        ? await this.transport.listOwnedGroupIds()
        : (await this.strategyGroups()).map(group => group.id)
    )
    for (const groupId of groupIds) {
      if (this.confirmedCanceledGroups.has(groupId)) continue
      try {
        const txHash = await this.transport.invalidate(
          groupId,
          this.safeObserver(onTransactionSubmitted)
        )
        if (txHash) submittedTransactions.push({ operation: 'cancel', txHash })
        this.confirmedCanceledGroups.add(groupId)
        await this.transport.forgetGroups?.([groupId])
      } catch (error) {
        failures.push({ groupId, errorName: operatorErrorName(error) })
      }
    }
    if (failures.length > 0) throw new BootstrapHardHaltError(failures)
    return { submittedTransactions }
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
