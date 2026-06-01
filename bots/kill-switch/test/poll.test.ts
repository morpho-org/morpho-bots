import { delay } from '@repo/utils'
import { describe, expect, it } from 'bun:test'
import { createPublicClient, custom } from 'viem'
import { mainnet } from 'viem/chains'

import { createPollingLoop, shouldRunTick } from '../src/poll'

// A real viem client whose eth_blockNumber answers come from a script (held at the last value once
// exhausted, simulating "no new block"). Returns raw hex — the wire shape viem decodes to bigint.
function scriptedClient(blockNumbersHex: readonly `0x${string}`[]) {
  let i = 0
  return createPublicClient({
    chain: mainnet,
    transport: custom({
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_blockNumber') {
          const value = blockNumbersHex[Math.min(i, blockNumbersHex.length - 1)]
          i += 1
          return value
        }
        throw new Error(`unexpected RPC method in test: ${method}`)
      }
    })
  })
}

describe('shouldRunTick', () => {
  it('runs on a strictly newer block', () => {
    expect(shouldRunTick(5n, 4n)).toBe(true)
  })

  it('skips the same block', () => {
    expect(shouldRunTick(5n, 5n)).toBe(false)
  })

  it('skips an older block', () => {
    expect(shouldRunTick(4n, 5n)).toBe(false)
  })
})

describe('createPollingLoop', () => {
  it('dispatches a tick on each new block and skips repeats', async () => {
    const client = scriptedClient(['0x1', '0x2', '0x2'])
    const seen: bigint[] = []
    const loop = createPollingLoop({
      client,
      pollIntervalMs: 1,
      onTick: async blockNumber => {
        seen.push(blockNumber)
      }
    })

    loop.start()
    await delay(50)
    await loop.stop()

    expect(seen).toEqual([1n, 2n])
  })

  it('lets overlapping ticks both complete without blocking polling (no cancellation)', async () => {
    const client = scriptedClient(['0x1', '0x2'])
    let active = 0
    let maxConcurrent = 0
    let completed = 0
    const loop = createPollingLoop({
      client,
      pollIntervalMs: 1,
      onTick: async () => {
        active += 1
        maxConcurrent = Math.max(maxConcurrent, active)
        await delay(20)
        active -= 1
        completed += 1
      }
    })

    loop.start()
    await delay(80)
    await loop.stop()

    expect(maxConcurrent).toBe(2)
    expect(completed).toBe(2)
  })
})
