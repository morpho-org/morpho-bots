import type { KillSwitchBotConfig } from './schema'

import { createBotClient } from './client'
import { startHealthServer } from './health'
import { createPollingLoop } from './poll'
import { validateConfig } from './schema'

// TODO Phase 8: make the health port operator-configurable.
const HEALTH_PORT = 8080

function logTick(blockNumber: bigint): void {
  console.log(JSON.stringify({ event: 'tick.start', blockNumber: blockNumber.toString() }))
}

// Assembles the per-(chain, vault) harness: validate config (fail loud), build the chain client,
// expose health, and run the polling loop with a stub tick (the real pipeline lands in Phases 3-7).
// The runnable self-start against an operator config lands in Phase 8 (CRTR-2557).
export function main(config: KillSwitchBotConfig): void {
  const validated = validateConfig(config)
  const client = createBotClient(validated.chain)
  const health = { ready: false }
  const server = startHealthServer({ port: HEALTH_PORT, getState: () => health })

  const loop = createPollingLoop({
    client,
    pollIntervalMs: validated.chain.pollIntervalMs,
    onTick: async blockNumber => {
      health.ready = true // bot is operating once it has observed a block
      logTick(blockNumber)
    }
  })

  const shutdown = () => {
    // TODO Phase 7: await loop.stop() to drain an in-flight write before exit.
    void loop.stop()
    void server.stop()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  loop.start()
}
