import { describe, expect, it } from 'bun:test'

import { setupFork } from './fork'

// Proves the shared fork harness boots and isolates state. Hermetic: a non-forked anvil (chainId
// 31337), so no ARCHIVE_RPC_URL is needed. Gated on anvil being on PATH — skips in the Unit-Test job
// and locally without Foundry, runs in the Integration CI job after `foundryup`. Later phases reuse
// setupFork with forkUrl/forkBlockNumber for real-state fork tests.
describe.skipIf(!Bun.which('anvil'))('fork harness smoke', () => {
  const fork = setupFork()

  // cacheTime: 0 on every read — viem caches block numbers (~seconds), which would otherwise
  // return a stale value after mining/reverting. This mirrors the polling loop's read.
  it('boots anvil and serves a block number', async () => {
    expect(typeof (await fork.getClient().getBlockNumber({ cacheTime: 0 }))).toBe('bigint')
  })

  it('mines blocks within a test', async () => {
    const before = await fork.getClient().getBlockNumber({ cacheTime: 0 })
    await fork.getClient().mine({ blocks: 3 })
    expect(await fork.getClient().getBlockNumber({ cacheTime: 0 })).toBe(before + 3n)
  })

  it('isolates tests via snapshot/revert (the previous test mine is gone)', async () => {
    expect(await fork.getClient().getBlockNumber({ cacheTime: 0 })).toBe(0n)
  })
})
