import type { BootstrapMakeService } from '../../application/bootstrap/position-bootstrap.service'

import { formatReadOnlyMakeEvent } from './read-only-make.utils'

/** Terminal-only bootstrap mutation adapter that never signs, publishes, or invalidates offers. */
export class ReadOnlyBootstrapMakeService implements BootstrapMakeService {
  /**
   * Creates a bootstrap dry-run adapter.
   * @param write - JSON Lines terminal writer; defaults to standard output.
   * @remarks Construction performs no signing, provider calls, or offer mutations. Each later make
   * request is emitted as one independently parseable JSON record.
   */
  constructor(private readonly write: (line: string) => void = console.log) {}

  /**
   * Logs the exact desired bootstrap reconciliation instead of submitting it.
   * @param parameters - Market, desired offer or invalidation, and stable reconciliation reason.
   * @returns `logged` after the terminal writer accepts one JSON line.
   * @throws When the injected terminal writer rejects the line.
   * @remarks No signing, publication, replacement, or invalidation occurs.
   */
  async reconcile(parameters: Parameters<BootstrapMakeService['reconcile']>[0]) {
    this.write(formatReadOnlyMakeEvent('bootstrap', 'reconcile', parameters))
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
    this.write(formatReadOnlyMakeEvent('bootstrap', 'hard-halt', parameters))
    return 'logged' as const
  }
}
