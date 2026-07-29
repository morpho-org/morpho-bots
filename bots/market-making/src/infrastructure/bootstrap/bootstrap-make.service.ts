import type { Hex } from 'viem'

import type { BootstrapMakeService } from '../../application/position-bootstrap.service'
import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { BootstrapActiveGroup } from './bootstrap-position.service'

import { operatorErrorName } from '../../application/operator-error-name.utils'
import { BootstrapAdapterError } from './bootstrap-adapter.error'
import { BootstrapHardHaltError } from './bootstrap-hard-halt.error'

type BootstrapBookOffer = { marketId: Hex; buy: boolean; tick: bigint }

/** Protocol transport for confirmed Midnight publication and group invalidation. */
interface BootstrapOfferTransport {
  /** Lists active strategy groups from Mempool truth. @returns Current active group projections. */
  listActiveGroups(): Promise<readonly BootstrapActiveGroup[]>
  /** Lists the maker's complete current book. @returns Every active offer needed for spread safety. */
  listBookOffers(): Promise<readonly BootstrapBookOffer[]>
  /** Projects a domain offer into its exact protocol tick. @param offer - Desired offer. @returns Prospective book offer. */
  toProspectiveBookOffer(offer: BootstrapOffer): Promise<BootstrapBookOffer>
  /** Builds and signs one publication without broadcasting it. @param offer - Desired offer. @returns Reserved group ID and a one-shot confirmed publisher. */
  preparePublication(offer: BootstrapOffer): Promise<{ groupId: Hex; publish(): Promise<void> }>
  /** Durably records publication intent before broadcast. @param group - Future group ID. @returns Completion after durable storage. */
  reserveGroup(group: Hex): Promise<void>
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
      if (parameters.desiredOffer) {
        const prospective = await this.transport.toProspectiveBookOffer(parameters.desiredOffer)
        const book = [...(await this.transport.listBookOffers()), prospective].filter(
          offer => offer.marketId === parameters.marketId
        )
        const buys = book.filter(offer => offer.buy).map(offer => offer.tick)
        const sells = book.filter(offer => !offer.buy).map(offer => offer.tick)
        if (
          buys.length > 0 &&
          sells.length > 0 &&
          buys.reduce((highest, tick) => (tick > highest ? tick : highest)) >=
            sells.reduce((lowest, tick) => (tick < lowest ? tick : lowest))
        ) {
          throw new BootstrapAdapterError('negative-spread')
        }
      }
      for (const group of groups.filter(item => item.marketId === parameters.marketId)) {
        await this.transport.invalidate(group.id)
      }
      if (parameters.desiredOffer) {
        const publication = await this.transport.preparePublication(parameters.desiredOffer)
        await this.transport.reserveGroup(publication.groupId)
        try {
          await publication.publish()
        } catch (error) {
          try {
            await this.transport.releaseGroupReservation(publication.groupId)
          } catch {
            throw new BootstrapAdapterError('publication-reservation-cleanup')
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
    return this.enqueue(async () => {
      const failures = []
      for (const group of await this.strategyGroups()) {
        try {
          await this.transport.invalidate(group.id)
        } catch (error) {
          failures.push({ groupId: group.id, errorName: operatorErrorName(error) })
        }
      }
      if (failures.length > 0) throw new BootstrapHardHaltError(failures)
    })
  }

  private strategyGroups = async () => {
    return this.transport.listActiveGroups()
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
