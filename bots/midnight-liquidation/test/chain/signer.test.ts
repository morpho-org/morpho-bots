import type { Hex } from 'viem'

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { base } from 'viem/chains'

import { createSigner } from '../../src/chain/signer'

// Throwaway well-known test key (anvil account #0) — never used to hold funds.
const KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const CONFIG = {
  chain: base,
  rpcUrl: 'http://localhost:8545',
  rpcUrlFallback: undefined,
  liquidatorPrivateKey: KEY
} as const

const TXHASH: Hex = `0x${'ab'.repeat(32)}`
const PROBE: Hex = `0x${'cd'.repeat(32)}`

// Canned JSON-RPC: maps method → result. Any unmocked method throws (surfaces a missing stub).
function mockRpc(results: Record<string, unknown>) {
  const handler = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
    const body = JSON.parse(init?.body ?? '{}') as { id: number; method: string }
    if (!(body.method in results)) throw new Error(`unmocked RPC method ${body.method}`)
    return Response.json({ jsonrpc: '2.0', id: body.id, result: results[body.method] })
  }
  return spyOn(globalThis, 'fetch').mockImplementation(handler as unknown as typeof fetch)
}

describe('createSigner', () => {
  afterEach(() => mock.restore())

  it('send returns the nonce-manager-assigned nonce and the tx hash', async () => {
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: TXHASH
    })
    const { send } = createSigner(CONFIG)
    const result = await send({
      to: `0x${'11'.repeat(20)}`,
      data: '0x',
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n
    })
    expect(result).toEqual({ nonce: 5, txHash: TXHASH })
  })

  it('getReceipt maps a found receipt to its status + block number', async () => {
    mockRpc({ eth_getTransactionReceipt: { status: '0x1', blockNumber: '0xa', logs: [] } })
    expect(await createSigner(CONFIG).getReceipt(PROBE)).toEqual({
      status: 'success',
      blockNumber: 10n
    })
  })

  it('getReceipt returns null while the tx is still pending (no receipt)', async () => {
    mockRpc({ eth_getTransactionReceipt: null })
    expect(await createSigner(CONFIG).getReceipt(PROBE)).toBeNull()
  })

  it('getBaseFee returns the latest base fee', async () => {
    mockRpc({ eth_getBlockByNumber: { baseFeePerGas: '0x7' } })
    expect(await createSigner(CONFIG).getBaseFee()).toBe(7n)
  })

  it('getBaseFee throws when the chain reports no base fee', async () => {
    mockRpc({ eth_getBlockByNumber: {} })
    expect(createSigner(CONFIG).getBaseFee()).rejects.toThrow(/baseFeePerGas/)
  })
})
