import { delay, ensureError, tryCatch } from '@repo/utils'

// Minimal structural view of the chain client the loop needs. A viem `PublicClient` satisfies it;
// tests pass a real client over a canned transport (per CONVENTIONS: inject faults at a real
// transport, never hand-mock the client).
type BlockSource = {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>
}

type PollingLoopParameters = {
  client: BlockSource
  pollIntervalMs: number
  onTick: (blockNumber: bigint) => Promise<void>
}

// Run the per-tick pipeline only when a strictly newer block has been observed.
export function shouldRunTick(blockNumber: bigint, lastSeen: bigint): boolean {
  return blockNumber > lastSeen
}

function logError(event: string, error: unknown): void {
  console.error(JSON.stringify({ event, error: ensureError(error).message }))
}

function handleTickError(error: unknown): void {
  logError('tick.error', error)
}

// HTTP block-polling loop. Each interval reads the freshest block (cacheTime: 0 — viem caches block
// numbers by default, which would make the loop skip blocks) and dispatches the tick when it
// advances. Ticks are fire-and-forget: a slow tick must not stall polling, and the writer is
// idempotent, so overlapping ticks are safe and need no AbortController (TIB Block ingestion).
export function createPollingLoop({ client, pollIntervalMs, onTick }: PollingLoopParameters) {
  // Held on an object so `stop()`'s mutation is visible to the loop (and to the linter).
  const state = { stopped: false, lastSeen: 0n }
  let loop: Promise<void> | undefined

  const runLoop = async () => {
    while (!state.stopped) {
      const result = await tryCatch(client.getBlockNumber({ cacheTime: 0 }))
      if (result.error) {
        logError('poll.failed', result.error)
      } else if (shouldRunTick(result.data, state.lastSeen)) {
        state.lastSeen = result.data // advance before dispatch so an overlap can't re-fire it
        void onTick(result.data).catch(handleTickError)
      }
      await delay(pollIntervalMs)
    }
  }

  return {
    // Single-use: once stopped the loop is not restartable (Phase 1 starts it once via main()).
    start(): void {
      if (loop) return
      loop = runLoop()
    },
    async stop(): Promise<void> {
      state.stopped = true
      await loop
    }
  }
}
