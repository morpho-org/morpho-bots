import type { LadderMakeService } from '../../application/ladder/ladder-market-maker.service'

import { formatReadOnlyMakeEvent } from './read-only-make.utils'

/** Read-through, terminal-only ladder adapter that suppresses every offer mutation. */
export class ReadOnlyLadderMakeService implements LadderMakeService {
  /**
   * Creates a ladder dry-run adapter around an active-quote reader.
   * @param activeQuotes - Read-only live quote-set source used for accurate reconciliation decisions.
   * @param write - JSON Lines terminal writer; defaults to standard output.
   * @remarks Construction performs no signing, provider calls, or offer mutations. Each later make
   * request is emitted as one independently parseable JSON record.
   */
  constructor(
    private readonly activeQuotes: Pick<LadderMakeService, 'readActive'>,
    private readonly write: (line: string) => void = console.log
  ) {}

  /**
   * Delegates active-root reconstruction to the injected read-only source.
   * @param marketId - Canonical market whose active ladder is required.
   * @returns The current strategy-owned quote set, or `undefined` when none remains active.
   * @throws When the injected active-quote reader cannot load or decode current roots.
   * @remarks Read-only; never signs, publishes, replaces, or invalidates offers.
   */
  readActive(marketId: Parameters<LadderMakeService['readActive']>[0]) {
    return this.activeQuotes.readActive(marketId)
  }

  /**
   * Logs the exact desired ladder reconciliation instead of submitting it.
   * @param parameters - Market, desired quote set or invalidation, and reconciliation reason.
   * @returns Completion after the terminal writer accepts one JSON line.
   * @throws When the injected terminal writer rejects the line.
   * @remarks No signing, publication, replacement, or invalidation occurs.
   */
  async reconcile(parameters: Parameters<LadderMakeService['reconcile']>[0]) {
    this.write(formatReadOnlyMakeEvent('ladder', 'reconcile', parameters))
  }

  /**
   * Logs the requested ladder safety halt instead of invalidating strategy roots.
   * @param parameters - Stable strategy-wide safety reason.
   * @returns Completion after the terminal writer accepts one JSON line.
   * @throws When the injected terminal writer rejects the line.
   * @remarks No signing or strategy-root invalidation occurs.
   */
  async hardHalt(parameters: Parameters<LadderMakeService['hardHalt']>[0]) {
    this.write(formatReadOnlyMakeEvent('ladder', 'hard-halt', parameters))
  }
}
