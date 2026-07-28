import type { Hex } from 'viem'

import type { BootstrapMakeService } from '../../application/position-bootstrap.service'
import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { BootstrapActiveGroup } from './bootstrap-position.service'

/** Protocol transport for confirmed Midnight publication and group invalidation. */
interface BootstrapOfferTransport {
  /** Lists active strategy groups from Mempool truth. @returns Current active group projections. */
  listActiveGroups(): Promise<readonly BootstrapActiveGroup[]>
  /** Builds, signs, validates, and publishes one lend offer. @param offer - Desired domain offer. @returns Published group ID after confirmation. */
  publish(offer: BootstrapOffer): Promise<Hex>
  /** Invalidates one active group onchain. @param group - Active group ID. @returns Completion after receipt confirmation. */
  invalidate(group: Hex): Promise<void>
}

/** Serialized production adapter for one-cycle bootstrap publication and hard halts. */
export class MidnightBootstrapMakeService implements BootstrapMakeService {
  private queue = Promise.resolve()
  private readonly sessionGroups = new Set<Hex>()

  /** Creates a singleton mutation queue. @param transport - Midnight SDK transport. @param configuredGroups - Strategy-owned group IDs. */
  constructor(
    private readonly transport: BootstrapOfferTransport,
    private readonly configuredGroups: readonly Hex[]
  ) {}

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
      for (const group of groups.filter(item => item.marketId === parameters.marketId)) {
        await this.transport.invalidate(group.id)
        this.sessionGroups.delete(group.id)
      }
      if (parameters.desiredOffer) {
        this.sessionGroups.add(await this.transport.publish(parameters.desiredOffer))
      }
    })
  }

  /**
   * Invalidates every configured or session-published bootstrap group serially.
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
        this.sessionGroups.delete(group.id)
      }
    })
  }

  private strategyGroups = async () => {
    const owned = new Set([...this.configuredGroups, ...this.sessionGroups])
    return (await this.transport.listActiveGroups()).filter(group => owned.has(group.id))
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
