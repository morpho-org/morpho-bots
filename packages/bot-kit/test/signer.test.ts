import type { Hex } from 'viem'

import { parseTransaction } from 'viem'
import { base } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Policy } from '../src/policy'

import { EXECUTOR_SELECTOR, PolicyViolationError } from '../src/policy'
import { createSigner } from '../src/signer'
import { TxSendError } from '../src/tx-send.error'

const EXECUTOR = `0x${'11'.repeat(20)}` as const
const POLICY: Policy = {
  chainId: base.id,
  targets: [EXECUTOR],
  maxFeePerGasWei: 300_000_000_000n,
  maxGasLimit: 15_000_000n,
  maxDataBytes: 65_536
}

// Throwaway well-known test key (anvil account #0) — never used to hold funds.
const KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const CONFIG = {
  chain: base,
  rpcUrl: 'http://localhost:8545',
  rpcUrlFallback: undefined,
  privateKey: KEY
} as const

const TXHASH: Hex = `0x${'ab'.repeat(32)}`
const PROBE: Hex = `0x${'cd'.repeat(32)}`

type RpcBody = { id: number; method: string; params?: unknown[] }
type RpcResult = unknown

// Canned JSON-RPC: maps method → result/function. Any unmocked method throws (surfaces a missing
// stub).
function mockRpc(results: Record<string, RpcResult>) {
  const handler = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
    const body = JSON.parse(init?.body ?? '{}') as RpcBody
    if (!(body.method in results)) throw new Error(`unmocked RPC method ${body.method}`)
    const value = results[body.method]
    const result = typeof value === 'function' ? await value(body) : value
    return Response.json({ jsonrpc: '2.0', id: body.id, result })
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(handler as unknown as typeof fetch)
}

describe('createSigner', () => {
  afterEach(() => vi.restoreAllMocks())

  it('send returns the signer-assigned nonce and the tx hash', async () => {
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

  it('claims sequential nonces, and syncNonce re-reads the chain pending nonce over the cursor', async () => {
    let pendingNonce = '0x5'
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: () => pendingNonce,
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: TXHASH
    })
    const { send, syncNonce } = createSigner(CONFIG)
    const req = {
      to: `0x${'11'.repeat(20)}` as const,
      data: '0x' as Hex,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n
    }
    expect((await send(req)).nonce).toBe(5) // first claim reads chain (5), cursor → 6
    expect((await send(req)).nonce).toBe(6) // second claim uses the local cursor, no re-read
    // A vanished/dropped tx left the chain pending nonce back at 5; without sync the cursor hands out
    // 7 (a future-nonce gap). syncNonce collapses it back to chain truth.
    await syncNonce()
    expect((await send(req)).nonce).toBe(5)
  })

  it('shares one cursor read across concurrent first sends and claims distinct nonces', async () => {
    // Defense in depth behind the pending queue's mutex: the lazy cursor init must not double-claim
    // when two sends race it. Only `eth_getTransactionCount` is counted — the memoized in-flight read
    // means one round trip, and the post-await `??=` means one nonce each.
    let counts = 0
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: () => {
        counts += 1
        return '0x5'
      },
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: TXHASH
    })
    const { send } = createSigner(CONFIG)
    const req = {
      to: `0x${'11'.repeat(20)}` as const,
      data: '0x' as Hex,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n
    }
    const results = await Promise.all([send(req), send(req)])
    expect(results.map(r => r.nonce).toSorted((a, b) => a - b)).toEqual([5, 6])
    expect(counts).toBe(1)
  })

  it('rolls back the local nonce cursor when raw broadcast fails before returning a hash', async () => {
    const rawNonces: number[] = []
    let sendCalls = 0
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: (body: RpcBody) => {
        sendCalls += 1
        const nonce = parseTransaction(body.params?.[0] as Hex).nonce
        if (nonce === undefined) throw new Error('expected serialized tx nonce')
        rawNonces.push(nonce)
        if (sendCalls === 1) throw new Error('rpc timeout after broadcast')
        return TXHASH
      }
    })
    const { send } = createSigner(CONFIG)
    const request = {
      to: `0x${'11'.repeat(20)}` as const,
      data: '0x' as Hex,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n
    }
    await expect(send(request)).rejects.toBeInstanceOf(TxSendError)
    expect(await send(request)).toEqual({ nonce: 5, txHash: TXHASH })
    expect(rawNonces).toEqual([5, 5])
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
    await expect(createSigner(CONFIG).getBaseFee()).rejects.toThrow(/baseFeePerGas/)
  })

  it('consumedNonce reads the latest (mined) transaction count', async () => {
    const calls: RpcBody[] = []
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: (body: RpcBody) => {
        calls.push(body)
        return '0x3'
      }
    })
    expect(await createSigner(CONFIG).consumedNonce()).toBe(3)
    // The reconciler needs mined truth, not the local pending cursor.
    expect(calls[0]?.params?.[1]).toBe('latest')
  })

  it('balance returns the EOA native balance in wei', async () => {
    mockRpc({ eth_chainId: `0x${base.id.toString(16)}`, eth_getBalance: '0xde0b6b3a7640000' })
    expect(await createSigner(CONFIG).balance()).toBe(1_000_000_000_000_000_000n)
  })

  it('signs and broadcasts a policy-compliant exec call', async () => {
    let sends = 0
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: () => {
        sends += 1
        return TXHASH
      }
    })
    const { send } = createSigner({ ...CONFIG, policy: POLICY })
    const result = await send({
      to: EXECUTOR,
      data: EXECUTOR_SELECTOR,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n
    })
    expect(result).toEqual({ nonce: 5, txHash: TXHASH })
    expect(sends).toBe(1)
  })

  it('rejects a non-Executor target before broadcasting and rolls the nonce back', async () => {
    let sends = 0
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: () => {
        sends += 1
        return TXHASH
      }
    })
    const { send } = createSigner({ ...CONFIG, policy: POLICY })
    // Target is the wrong contract → policy 'target' violation, thrown before any raw broadcast.
    await expect(
      send({
        to: `0x${'99'.repeat(20)}`,
        data: EXECUTOR_SELECTOR,
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000n
      })
    ).rejects.toBeInstanceOf(PolicyViolationError)
    expect(sends).toBe(0) // nothing broadcast
    // The rolled-back cursor lets a subsequent compliant send reuse nonce 5.
    expect(
      await send({
        to: EXECUTOR,
        data: EXECUTOR_SELECTOR,
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000n
      })
    ).toEqual({ nonce: 5, txHash: TXHASH })
  })

  it('rejects a non-exec selector before broadcasting', async () => {
    let sends = 0
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: () => {
        sends += 1
        return TXHASH
      }
    })
    const { send } = createSigner({ ...CONFIG, policy: POLICY })
    await expect(
      send({
        to: EXECUTOR,
        data: '0xdeadbeef',
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000n
      })
    ).rejects.toMatchObject({ check: 'selector' })
    expect(sends).toBe(0)
  })
})
