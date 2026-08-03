import type { BootstrapMakeService } from '../../application/bootstrap/position-bootstrap.service'

import { formatReadOnlyMakeEvent } from './read-only-make.utils'

/** Terminal-only bootstrap mutation adapter that never signs, publishes, or invalidates offers. */
export class ReadOnlyBootstrapMakeService implements BootstrapMakeService {
  /**
   * Creates a bootstrap dry-run adapter.
   * @param write - JSON Lines terminal writer; defaults to standard output.
   * @param validate - Optional fresh whole-book validation performed before a reconcile is logged.
   * @remarks Construction performs no signing, provider calls, or offer mutations. Each later make
   * request is validated and emitted as one independently parseable JSON record.
   */
  constructor(
    private readonly write: (line: string) => void | Promise<void> = console.log,
    private readonly validate: (
      parameters: Parameters<BootstrapMakeService['reconcile']>[0]
    ) => Promise<void> = async () => {}
  ) {}

  /**
   * Logs the exact desired bootstrap reconciliation instead of submitting it.
   * @param parameters - Market, desired offer or invalidation, and stable reconciliation reason.
   * @returns `logged` after the terminal writer accepts one JSON line.
   * @throws When the injected terminal writer rejects the line.
   * @remarks Production read-only composition reloads active groups and the complete maker book,
   * derives the exact protocol tick, and applies the same negative-spread guard as live mode. No
   * signing, publication, replacement, or invalidation occurs.
   */
  async reconcile(parameters: Parameters<BootstrapMakeService['reconcile']>[0]) {
    await this.validate(parameters)
    await this.write(formatReadOnlyMakeEvent('bootstrap', 'reconcile', parameters))
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
