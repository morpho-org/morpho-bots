import type { Hex } from 'viem'

import type { BootstrapMakeService } from '../../application/position-bootstrap.service'
import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { BootstrapActiveGroup } from './bootstrap-position.service'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

type BootstrapBookOffer = { marketId: Hex; buy: boolean; tick: bigint }

/** Protocol transport for confirmed Midnight publication and group invalidation. */
interface BootstrapOfferTransport {
  /** Lists active strategy groups from Mempool truth. @returns Current active group projections. */
  listActiveGroups(): Promise<readonly BootstrapActiveGroup[]>
  /** Lists the maker's complete current book. @returns Every active offer needed for spread safety. */
  listBookOffers(): Promise<readonly BootstrapBookOffer[]>
  /** Projects a domain offer into its exact protocol tick. @param offer - Desired offer. @returns Prospective book offer. */
  toProspectiveBookOffer(offer: BootstrapOffer): Promise<BootstrapBookOffer>
  /** Builds, signs, validates, and publishes one lend offer. @param offer - Desired offer. @returns Published group ID after confirmation. */
  publish(offer: BootstrapOffer): Promise<Hex>
  /** Durably records a confirmed bot-issued group. @param group - Published group ID. @returns Completion after durable storage. */
  rememberPublishedGroup(group: Hex): Promise<void>
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
        const publishedGroup = await this.transport.publish(parameters.desiredOffer)
        await this.transport.rememberPublishedGroup(publishedGroup)
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
      for (const group of await this.strategyGroups()) {
        await this.transport.invalidate(group.id)
      }
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
