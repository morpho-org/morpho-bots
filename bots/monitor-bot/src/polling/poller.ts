import type { Logger } from '@repo/bot-kit'

import type { Alert, AlertDispatcher } from '../alerts/alert'
import type { PriceLookup } from '../tokens/prices'
import type { TokenRegistry } from '../tokens/registry'

/** Injection token for the array of registered pollers (Nest has no multi-providers). */
export const POLLERS = Symbol('POLLERS')

/**
 * The cross-tick state a poller carries, from the base class's point of view. Deliberately
 * neutral: what the state *means* differs per poller and is the concrete store's business.
 *
 * - `CursorStore` holds a resume position (a watermark you fetch forward from).
 * - `BootSnapshotStore` holds a snapshot of observed state, replaced wholesale each tick.
 *
 * They share a shape but not a meaning, so they keep separate types and separate Nest tokens —
 * that also stops a future persistent CursorStore from silently persisting boot snapshots too.
 */
export type PollerStateStore = {
  get<T>(id: string): Promise<T | null>
  set<T>(id: string, value: T): Promise<void>
}

/**
 * Constructor deps for pollers. A single object parameter cannot be resolved by Nest constructor
 * injection — provide concrete pollers via `useFactory` with
 * `inject: [CURSOR_STORE | BOOT_SNAPSHOT_STORE, ALERT_DISPATCHER, LOGGER]`.
 */
export type PollerDependencies = {
  state: PollerStateStore
  dispatcher: AlertDispatcher
  logger: Logger
  /**
   * market id → token addresses. Shared by every poller: transaction items carry only a
   * `market_id`, so this is the only way to learn what their amounts are denominated in.
   */
  tokens: TokenRegistry
  /** USD spot prices for those tokens — the $-figures alerts print next to token amounts. */
  prices: PriceLookup
}

// Template method: subclasses supply fetch + toAlerts, the base class owns the invariant tick
// pipeline. Locked-in semantics:
// - State is written only after a successful dispatch → at-least-once alert delivery.
// - A failed tick never writes state → the next tick retries the same window, which is what makes
//   restart-after-a-failed-request robust without any retry logic here.
// - No overlap handling here — the cron engine skips ticks while one is in flight
//   (waitForCompletion, see PollerRegistrar).
export abstract class Poller<TState, TItem> {
  abstract readonly id: string
  /** Cron expression driving this poller — an instance property so it can come from config. */
  abstract readonly cron: string

  constructor(protected readonly deps: PollerDependencies) {}

  /**
   * Fetch new items given the previous state. A `null` state means nothing is saved (first tick or
   * post-restart): anchor at boot/now rather than replaying history, and surface the unscanned
   * window to operators (gap notice) instead of silently skipping it.
   */
  protected abstract fetch(state: TState | null): Promise<{ items: TItem[]; nextState: TState }>

  protected abstract toAlerts(items: TItem[]): Alert[]

  async pollOnce() {
    const state = await this.deps.state.get<TState>(this.id)
    const { items, nextState } = await this.fetch(state)
    const alerts = this.toAlerts(items)
    if (alerts.length > 0) await this.deps.dispatcher.send(alerts)
    await this.deps.state.set(this.id, nextState)
    this.deps.logger.debug('poll.tick', {
      pollerId: this.id,
      items: items.length,
      alerts: alerts.length
    })
  }
}
