import { Injectable } from '@nestjs/common'

export const CURSOR_STORE = Symbol('CURSOR_STORE')

export interface CursorStore {
  get<T>(id: string): Promise<T | null>
  set<T>(id: string, cursor: T): Promise<void>
}

// In-process only, matching the repo's cross-tick-state philosophy: nothing is persisted to disk
// and API truth wins on restart (pollers re-anchor from boot time). The interface keeps a
// file/db-backed store a drop-in replacement if replay-across-restarts is ever wanted.
@Injectable()
export class InMemoryCursorStore implements CursorStore {
  private readonly cursors = new Map<string, unknown>()

  get<T>(id: string) {
    return Promise.resolve((this.cursors.get(id) as T | undefined) ?? null)
  }

  set<T>(id: string, cursor: T) {
    this.cursors.set(id, cursor)
    return Promise.resolve()
  }
}
