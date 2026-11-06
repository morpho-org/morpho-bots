import type { Hex } from 'viem'

import { getChainAddress } from '@morpho-org/morpho-ts'
import { encodeAbiParameters } from 'viem'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { ConfigService } from '../../../src/config/config.service'

import { createWorldReads } from '../../../src/infrastructure/engine/world-reads'

const CHAIN_ID = 8453
const maker: Hex = '0x1111111111111111111111111111111111111111'
const marketId: Hex = `0x${'11'.repeat(32)}`
const group: Hex = `0x${'22'.repeat(32)}`
const HELD: Hex = `0x${'aa'.repeat(32)}`
const REORGED: Hex = `0x${'bb'.repeat(32)}`
const blockOf = (hash: Hex) => ({ number: 7n, hash, timestamp: 1_000n })

const config = {
  chainId: CHAIN_ID,
  rpcUrl: 'https://rpc.example',
  requestTimeoutMs: 1_000,
  morphoApiBaseUrl: 'https://api.example',
  identity: { maker },
  setup: {
    loanAsset: '0x3333333333333333333333333333333333333333',
    midnight: getChainAddress(CHAIN_ID, 'midnight')
  }
} as unknown as ConfigService

type RpcRequest = Readonly<{ id: number; method: string; params: readonly unknown[] }>

/**
 * A node that holds only the block `HELD` at height 7, as after a reorg replaced `REORGED`: a call
 * pinned to a hash it does not hold fails, as EIP-1898 requires, and every call's block parameter
 * is recorded.
 */
const node = () => {
  const blocks: unknown[] = []
  const answer = (request: RpcRequest) => {
    if (request.method === 'eth_chainId') return { result: `0x${CHAIN_ID.toString(16)}` }
    if (request.method !== 'eth_call') return { error: { code: -32601, message: 'unsupported' } }
    const block = request.params[1]
    blocks.push(block)
    if ((block as { blockHash?: Hex } | undefined)?.blockHash !== HELD)
      return { error: { code: -32000, message: 'header not found' } }
    return { result: encodeAbiParameters([{ type: 'uint256' }], [42n]) }
  }
  vi.stubGlobal('fetch', async (_: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as RpcRequest | RpcRequest[]
    const reply = (request: RpcRequest) => ({ jsonrpc: '2.0', id: request.id, ...answer(request) })
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), {
      headers: { 'content-type': 'application/json' }
    })
  })
  return blocks
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the production world reads', () => {
  test('read each chain value at the block they are pinned to by hash', async () => {
    const blocks = node()
    const reads = createWorldReads(config)

    expect(await reads.readCash(blockOf(HELD))).toEqual({ cashBalance: 42n, allowance: 42n })
    expect(blocks).toEqual([
      { blockHash: HELD, requireCanonical: true },
      { blockHash: HELD, requireCanonical: true }
    ])
  })

  test('fail every chain read at a block the node no longer holds, never reading by number', async () => {
    const blocks = node()
    const reads = createWorldReads(config)
    const block = blockOf(REORGED)

    await expect(reads.readCash(block)).rejects.toThrow()
    await expect(reads.readConsumed([group], block)).rejects.toThrow()
    await expect(reads.readMarket(marketId, block)).rejects.toThrow()
    await expect(reads.readPosition(marketId, block)).rejects.toThrow()
    expect(blocks.length).toBeGreaterThanOrEqual(5)
    for (const pinned of blocks)
      expect(pinned).toEqual({ blockHash: REORGED, requireCanonical: true })
  })
})
