import { Injectable } from '@nestjs/common'

import type { PollerStateStore } from '../polling/poller'

export const BOOT_SNAPSHOT_STORE = Symbol('BOOT_SNAPSHOT_STORE')

/**
 * State for pollers whose upstream has no change feed — only an active-only view of "what is true
 * right now". There is no position to resume from, so such a poller stores the previous
 * observation and derives its items from the diff.
 *
 * Called a *boot* snapshot because its lifetime is exactly one process lifetime: the first tick
 * after boot establishes a baseline (deliberately silent — alerting the whole standing world on
 * every deploy would be pure noise), and a restart drops it so the next boot re-baselines. That
 * is the meaningful difference from `CursorStore`, which is a resume position that a persistent
 * implementation could legitimately carry across restarts to replay a missed window. A boot
 * snapshot must never be persisted: a stale one diffed against live data reports every change
 * made while the process was down as if it had just happened.
 */
export interface BootSnapshotStore extends PollerStateStore {}

/**
 * In-process only, matching the repo's cross-tick-state philosophy: nothing is persisted to disk
 * and API truth wins on restart. Unlike `InMemoryCursorStore` this is not a stand-in for a
 * durable implementation — in-memory is the correct and intended lifetime (see above).
 */
@Injectable()
export class InMemoryBootSnapshotStore implements BootSnapshotStore {
  private readonly snapshots = new Map<string, unknown>()

  get<T>(id: string) {
    return Promise.resolve((this.snapshots.get(id) as T | undefined) ?? null)
  }

  set<T>(id: string, value: T) {
    this.snapshots.set(id, value)
    return Promise.resolve()
  }
}
