import type { BootstrapMakeService } from '../../application/bootstrap/position-bootstrap.service'

import { formatReadOnlyMakeEvent } from './read-only-make.utils'

/** Terminal-only bootstrap mutation adapter that never signs, publishes, or invalidates offers. */
export class ReadOnlyBootstrapMakeService implements BootstrapMakeService {
  /**
   * Creates a bootstrap dry-run adapter.
   * @param write - JSON Lines terminal writer; defaults to standard output.
   * @param validate - Optional fresh whole-book validation and adjustment performed before logging;
   * returns the exact safe request that live mode would publish or invalidate.
   * @remarks Construction performs no signing, provider calls, or offer mutations. Each later make
   * request is validated, adjusted when eligible ladder overlap exists, and emitted as one
   * independently parseable JSON record.
   */
  constructor(
    private readonly write: (line: string) => void | Promise<void> = console.log,
    private readonly validate: (
      parameters: Parameters<BootstrapMakeService['reconcile']>[0]
    ) => Promise<Parameters<BootstrapMakeService['reconcile']>[0]> = async parameters => parameters
  ) {}

  /**
   * Resolves the same adjusted offer used by the later read-only reconciliation.
   * @param parameters - Desired offer and configured hard bounds.
   * @returns Adjusted offer or no offer when ladder liquidity covers it completely.
   * @throws When fresh whole-book validation rejects the publication.
   * @remarks Read-only; performs no signing, persistence, or protocol mutation.
   */
  async preview(parameters: Parameters<NonNullable<BootstrapMakeService['preview']>>[0]) {
    const validated = await this.validate({
      marketId: parameters.marketId,
      desiredOffer: parameters.desiredOffer,
      minimumRateBps: parameters.minimumRateBps,
      maximumRateBps: parameters.maximumRateBps,
      reason: 'publish'
    })
    return validated.desiredOffer
  }

  /**
   * Logs the exact desired bootstrap reconciliation instead of submitting it.
   * @param parameters - Market, desired offer or invalidation, and stable reconciliation reason.
   * @returns `logged` after the terminal writer accepts one JSON line.
   * @throws When the injected terminal writer rejects the line.
   * @remarks Production read-only composition reloads active groups and the complete maker book,
   * derives the exact protocol tick, applies the same fail-closed overlap handling as live mode,
   * and logs the adjusted positive remainder or an invalidation-only request. No signing,
   * publication, replacement, or invalidation occurs.
   */
  async reconcile(parameters: Parameters<BootstrapMakeService['reconcile']>[0]) {
    const validated = await this.validate(parameters)
    await this.write(formatReadOnlyMakeEvent('bootstrap', 'reconcile', validated))
    return 'logged' as const
  }

  /**
   * Logs the requested bootstrap safety halt instead of invalidating strategy roots.
   * @param parameters - Stable strategy-wide safety reason.
   * @returns `logged` after the terminal writer accepts one JSON line.
   * @throws When the injected terminal writer rejects the line.
   * @remarks No signing or strategy-root invalidation occurs.
   */
  async hardHalt(parameters: Parameters<BootstrapMakeService['hardHalt']>[0]) {
    await this.write(formatReadOnlyMakeEvent('bootstrap', 'hard-halt', parameters))
    return 'logged' as const
  }

  /**
   * Logs graceful strategy cleanup instead of invalidating owned groups.
   * @returns `logged` after the terminal writer accepts one JSON line.
   * @throws When the injected terminal writer rejects the line.
   * @remarks No signing or strategy-root invalidation occurs.
   */
  async cleanup() {
    await this.write(formatReadOnlyMakeEvent('bootstrap', 'cleanup', { reason: 'shutdown' }))
    return 'logged' as const
  }
}
