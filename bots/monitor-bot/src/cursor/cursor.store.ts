import { Injectable } from '@nestjs/common'

import type { PollerStateStore } from '../polling/poller'

export const CURSOR_STORE = Symbol('CURSOR_STORE')

/**
 * A resume position: the watermark a poller fetches forward from. For pollers whose upstream has
 * no change feed to resume within, see `BootSnapshotStore` — a snapshot is not a cursor, and the
 * two must not share a store (a snapshot is never safe to persist).
 */
export interface CursorStore extends PollerStateStore {}

// In-process only, matching the repo's cross-tick-state philosophy: nothing is persisted to disk
// and API truth wins on restart (pollers re-anchor from boot time). The interface keeps a
// file/db-backed store a drop-in replacement if replay-across-restarts is ever wanted.
@Injectable()
export class InMemoryCursorStore implements CursorStore {
  private readonly cursors = new Map<string, unknown>()

  get<T>(id: string) {
    return Promise.resolve((this.cursors.get(id) as T | undefined) ?? null)
  }

  set<T>(id: string, value: T) {
    this.cursors.set(id, value)
    return Promise.resolve()
  }
}
