import type { Chain, Hex } from 'viem'

import { spawnAnvil } from '@morpho-org/test'
import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test'
import { createTestClient, http, publicActions, walletActions } from 'viem'
import { foundry } from 'viem/chains'

type SetupForkOptions = {
  // Phase 1's smoke test runs non-forked (foundry, chainId 31337); later phases pass a forkUrl +
  // forkBlockNumber to fork a real chain, and the matching `chain` (e.g. mainnet) for it.
  chain?: Chain
  forkUrl?: string
  forkBlockNumber?: number | bigint
}

const makeClient = (chain: Chain, rpcUrl: string) =>
  createTestClient({ chain, mode: 'anvil', transport: http(rpcUrl) })
    .extend(publicActions)
    .extend(walletActions)

// Shared anvil fork harness (TIB Testing). Spawns anvil once per describe and isolates each test
// with a snapshot/revert taken in beforeEach/afterEach. Returns a `getClient` accessor (the client
// only exists after beforeAll). spawnAnvil's `stop` is synchronous, so afterAll does not await it.
export function setupFork(options: SetupForkOptions = {}) {
  const chain = options.chain ?? foundry
  let client: ReturnType<typeof makeClient> | undefined
  let stop: (() => boolean) | undefined
  let snapshotId: Hex

  const getClient = () => {
    if (!client) throw new Error('fork client is not ready (use it inside a test, after beforeAll)')
    return client
  }

  beforeAll(async () => {
    const anvil = await spawnAnvil({
      forkUrl: options.forkUrl,
      forkBlockNumber: options.forkBlockNumber
    })
    stop = anvil.stop
    client = makeClient(chain, anvil.rpcUrl)
  })
  afterAll(() => stop?.())
  beforeEach(async () => {
    snapshotId = await getClient().snapshot()
  })
  afterEach(async () => {
    await getClient().revert({ id: snapshotId })
  })

  return { getClient }
}
