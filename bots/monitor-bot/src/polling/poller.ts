import type { Logger } from '@repo/bot-kit'

import type { Alert, AlertDispatcher } from '../alerts/alert'
import type { CursorStore } from '../cursor/cursor.store'

/** Injection token for the array of registered pollers (Nest has no multi-providers). */
export const POLLERS = Symbol('POLLERS')

/**
 * Constructor deps for pollers. A single object parameter cannot be resolved by Nest constructor
 * injection — provide concrete pollers via `useFactory` with
 * `inject: [CURSOR_STORE, ALERT_DISPATCHER, LOGGER]`.
 */
export type PollerDependencies = {
  cursors: CursorStore
  dispatcher: AlertDispatcher
  logger: Logger
}

// Template method: subclasses supply fetch + toAlerts, the base class owns the invariant tick
// pipeline. Locked-in semantics:
// - The cursor advances only after a successful dispatch → at-least-once alert delivery.
// - A failed tick never advances the cursor → the next tick retries the same window, which is
//   what makes restart-after-a-failed-request robust without any retry logic here.
// - No overlap handling here — the cron engine skips ticks while one is in flight
//   (waitForCompletion, see PollerRegistrar).
export abstract class Poller<TCursor, TItem> {
  abstract readonly id: string
  /** Cron expression driving this poller — an instance property so it can come from config. */
  abstract readonly cron: string

  constructor(protected readonly deps: PollerDependencies) {}

  /**
   * Fetch new items after `cursor`. A `null` cursor means there is no saved position (first tick
   * or post-restart): anchor at boot/now rather than replaying history, and surface the unscanned
   * window to operators (gap notice) instead of silently skipping it.
   */
  protected abstract fetch(cursor: TCursor | null): Promise<{ items: TItem[]; nextCursor: TCursor }>

  protected abstract toAlerts(items: TItem[]): Alert[]

  async pollOnce() {
    const cursor = await this.deps.cursors.get<TCursor>(this.id)
    const { items, nextCursor } = await this.fetch(cursor)
    const alerts = this.toAlerts(items)
    if (alerts.length > 0) await this.deps.dispatcher.send(alerts)
    await this.deps.cursors.set(this.id, nextCursor)
    this.deps.logger.debug('poll.tick', {
      pollerId: this.id,
      items: items.length,
      alerts: alerts.length
    })
  }
}
