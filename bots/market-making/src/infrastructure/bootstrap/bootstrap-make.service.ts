import type { Hex } from 'viem'

import type {
  BootstrapMakeResult,
  BootstrapSubmittedTransaction,
  BootstrapTransactionSubmittedObserver
} from '../../application/bootstrap/position-bootstrap-verbose'
import type { BootstrapMakeService } from '../../application/bootstrap/position-bootstrap.service'
import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'
import type { BootstrapActiveGroup } from './bootstrap-position.service'

import { BootstrapOwnershipCleanupError } from '../../application/bootstrap/bootstrap-ownership-cleanup.error'
import { operatorErrorName } from '../../application/operator-error-name.utils'
import { BootstrapAdapterError } from './bootstrap-adapter.error'
import { BootstrapHardHaltError } from './bootstrap-hard-halt.error'
import { assertBootstrapProspectiveSpread, bootstrapMarketGroupIds } from './bootstrap-spread.utils'

type BootstrapBookOffer = { groupId?: Hex; marketId: Hex; buy: boolean; tick: bigint }

/** Protocol transport for confirmed Midnight publication and group invalidation. */
interface BootstrapOfferTransport {
  /** Lists active strategy groups from Mempool truth. @returns Current active group projections. */
  listActiveGroups(): Promise<readonly BootstrapActiveGroup[]>
  /** Lists every explicitly owned group, including fully consumed groups. @returns Owned group IDs for exhaustive cleanup. */
  listOwnedGroupIds?(): Promise<readonly Hex[]>
  /** Lists the maker's complete current book. @returns Every active offer needed for spread safety. */
  listBookOffers(): Promise<readonly BootstrapBookOffer[]>
  /** Projects a domain offer into its exact protocol tick. @param offer - Desired offer. @returns Prospective book offer. */
  toProspectiveBookOffer(offer: BootstrapOffer): Promise<BootstrapBookOffer>
  /** Prepares one policy-checked publication without broadcasting it. @param offer - Desired offer. @returns Reserved group ID and a one-shot confirmed ratifier/publisher. */
  preparePublication(offer: BootstrapOffer): Promise<{
    groupId: Hex
    publish(
      onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
    ): Promise<Hex | void | readonly BootstrapSubmittedTransaction[]>
  }>
  /** Durably records publication intent before broadcast. @param group - Future group ID. @returns Completion after durable storage. */
  reserveGroup(group: Hex, offer: BootstrapOffer): Promise<void>
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
   * @remarks Mutations are serialized; publication never races invalidation.
   */
  reconcile(parameters: {
    marketId: Hex
    desiredOffer?: BootstrapOffer
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
      const spreadReplacedGroupIds = new Set([
        ...bootstrapMarketGroupIds(groups, parameters.marketId),
        ...this.confirmedCanceledGroups
      ])
      const invalidatedGroupIds = new Set(
        [...spreadReplacedGroupIds].filter(groupId => !this.confirmedCanceledGroups.has(groupId))
      )
      let publication:
        | Awaited<ReturnType<BootstrapOfferTransport['preparePublication']>>
        | undefined
      if (parameters.desiredOffer) {
        const prospective = await this.transport.toProspectiveBookOffer(parameters.desiredOffer)
        assertBootstrapProspectiveSpread({
          marketId: parameters.marketId,
          replacedGroupIds: spreadReplacedGroupIds,
          book: await this.transport.listBookOffers(),
          prospective
        })
        publication = await this.transport.preparePublication(parameters.desiredOffer)
        await this.transport.reserveGroup(publication.groupId, parameters.desiredOffer)
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
