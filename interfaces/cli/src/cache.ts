import { loadState, saveState } from './state'

// sense/act caches are disposable and best-effort — they affect latency/recall, never transaction
// validity — so a missing/corrupt/version-mismatched file simply degrades to a rebuild. The CLI
// wraps the core's opaque cache payload in a `{ version, data }` envelope so the shared version-gated
// loadState/saveState can discard a stale shape.
type CacheEnvelope = { version: number; data: unknown }

/**
 * Reads a stage cache, or `null` when absent/corrupt/stale. A `null` return is the CLI's signal to
 * run the stage's boot-time startup checks (first run on a fresh host or after a schema bump).
 */
export function loadCache(path: string, version: number): unknown {
  const { state } = loadState<CacheEnvelope>(path, version)
  return state ? state.data : null
}

/** Atomically persists a stage cache under its version envelope (last-writer-wins; no lock). */
export function saveCache(path: string, version: number, data: unknown): void {
  saveState(path, { version, data })
}
