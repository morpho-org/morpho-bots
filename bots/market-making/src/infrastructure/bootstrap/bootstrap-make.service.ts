import type { Hex } from 'viem'

import type { BootstrapMakeService } from '../../application/bootstrap/position-bootstrap.service'
import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'
import type { BootstrapActiveGroup } from './bootstrap-position.service'

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
  /** Builds and signs one publication without broadcasting it. @param offer - Desired offer. @returns Reserved group ID and a one-shot confirmed publisher. */
  preparePublication(offer: BootstrapOffer): Promise<{ groupId: Hex; publish(): Promise<void> }>
  /** Durably records publication intent before broadcast. @param group - Future group ID. @returns Completion after durable storage. */
  reserveGroup(group: Hex, offer: BootstrapOffer): Promise<void>
  /** Finalizes a confirmed group while retaining ownership. @param group - Confirmed group ID. @returns Completion after durable storage. */
  confirmPublishedGroup(group: Hex): Promise<void>
  /** Removes intent after publication fails. @param group - Unpublished group ID. @returns Completion after durable storage. */
  releaseGroupReservation(group: Hex): Promise<void>
  /** Invalidates one active group onchain. @param group - Active group ID. @returns Completion after receipt confirmation. */
  invalidate(group: Hex): Promise<void>
}

/** Serialized production adapter for one-cycle bootstrap publication and hard halts. */
export class MidnightBootstrapMakeService implements BootstrapMakeService {
  private queue = Promise.resolve()

  /** Creates a singleton mutation queue. @param transport - Midnight SDK transport. */
  constructor(private readonly transport: BootstrapOfferTransport) {}

  /**
   * Reconciles one market after reloading Mempool truth inside the mutation queue.
   * @param parameters - Market, desired lend offer, and audited decision reason.
   * @returns Completion after invalidations/publication have confirmed.
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
  }) {
    return this.enqueue(async () => {
      const groups = await this.strategyGroups()
      const marketGroupIds = bootstrapMarketGroupIds(groups, parameters.marketId)
      let publication:
        | Awaited<ReturnType<BootstrapOfferTransport['preparePublication']>>
        | undefined
      if (parameters.desiredOffer) {
        const prospective = await this.transport.toProspectiveBookOffer(parameters.desiredOffer)
        assertBootstrapProspectiveSpread({
          marketId: parameters.marketId,
          replacedGroupIds: marketGroupIds,
          book: await this.transport.listBookOffers(),
          prospective
        })
        publication = await this.transport.preparePublication(parameters.desiredOffer)
        await this.transport.reserveGroup(publication.groupId, parameters.desiredOffer)
      }
      try {
        for (const groupId of marketGroupIds) {
          await this.transport.invalidate(groupId)
        }
      } catch (error) {
        if (publication) {
          try {
            await this.transport.releaseGroupReservation(publication.groupId)
          } catch {
            throw new BootstrapAdapterError('publication-reservation-cleanup')
          }
        }
        throw error
      }
      if (publication) {
        try {
          await publication.publish()
        } catch (error) {
          if (
            error instanceof BootstrapAdapterError &&
            error.operation === 'transaction-reverted'
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
    })
  }

  /**
   * Invalidates every currently re-derived strategy bootstrap group serially.
   * @param parameters - Stable strategy-wide halt reason.
   * @returns Completion after all active groups have confirmed invalidation.
   * @throws When listing or invalidating any group fails.
   */
  hardHalt(parameters: {
    reason:
      | 'reference-read-failed'
      | 'bootstrap-decision-failed'
      | 'bootstrap-configuration-failed'
      | 'market-invalidation-failed'
  }) {
    void parameters
    return this.enqueue(() => this.invalidateOwnedGroups())
  }

  /**
   * Invalidates every explicitly owned bootstrap group during graceful shutdown.
   * @returns Completion after every cancellation attempt and receipt confirmation.
   * @throws `BootstrapHardHaltError` after all groups are attempted when any cancellation fails.
   * @remarks Cleanup enters the same mutation queue as publication and normal reconciliation.
   */
  cleanup() {
    return this.enqueue(() => this.invalidateOwnedGroups())
  }

  private strategyGroups = async () => {
    return this.transport.listActiveGroups()
  }

  private async invalidateOwnedGroups() {
    const failures = []
    const groupIds = new Set(
      this.transport.listOwnedGroupIds
        ? await this.transport.listOwnedGroupIds()
        : (await this.strategyGroups()).map(group => group.id)
    )
    for (const groupId of groupIds) {
      try {
        await this.transport.invalidate(groupId)
      } catch (error) {
        failures.push({ groupId, errorName: operatorErrorName(error) })
      }
    }
    if (failures.length > 0) throw new BootstrapHardHaltError(failures)
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
