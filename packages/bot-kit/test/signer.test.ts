import type { Hex } from 'viem'

import { InvalidInputRpcError, keccak256, MethodNotFoundRpcError, parseTransaction } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Logger } from '../src/logger'
import type { Policy } from '../src/policy'

import { EXECUTOR_SELECTOR, PolicyViolationError } from '../src/policy'
import { createAccountSigner, createSigner } from '../src/signer'

// The `eth_estimateGas` these tests mock (0x5208). The signer returns it so the queue can price its
// own bump ladder against the spend ceiling.
const STUB_GAS = 21_000n

const EXECUTOR = `0x${'11'.repeat(20)}` as const
const POLICY: Policy = {
  chainId: base.id,
  targets: [EXECUTOR],
  maxFeePerGasWei: 300_000_000_000n,
  maxSpendWei: 5n * 10n ** 17n,
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
type RpcFailure = { rpcError: { code: number; message: string } }

const rpcFailure = (code: number, message: string): RpcFailure => ({
  rpcError: { code, message }
})

const isRpcFailure = (value: unknown): value is RpcFailure =>
  typeof value === 'object' && value !== null && 'rpcError' in value

const signedTransactionHash = (body: RpcBody): Hex => keccak256(body.params?.[0] as Hex)

// Canned JSON-RPC: maps method → result/function. Any unmocked method answers "method not found",
// as a node without it would; viem does not retry that code, so `eth_fillTransaction` falls back
// at once and a genuinely missing stub still fails the call it belongs to.
function mockRpc(results: Record<string, unknown>) {
  const handler = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
    const body = JSON.parse(init?.body ?? '{}') as RpcBody
    const value =
      body.method in results
        ? results[body.method]
        : rpcFailure(MethodNotFoundRpcError.code, `unmocked RPC method ${body.method}`)
    const result = typeof value === 'function' ? await value(body) : value
    if (isRpcFailure(result)) {
      return Response.json({ jsonrpc: '2.0', id: body.id, error: result.rpcError })
    }
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
      eth_sendRawTransaction: signedTransactionHash
    })
    const { send } = createSigner(CONFIG)
    const result = await send({
      to: `0x${'11'.repeat(20)}`,
      data: '0x',
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n
    })
    expect(result).toMatchObject({ nonce: 5, txHash: expect.any(String), gas: STUB_GAS })
    expect(result.broadcastUnknown).toBeUndefined()
  })

  it('uses a caller-provided local account through the same send path', async () => {
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: signedTransactionHash
    })
    const account = privateKeyToAccount(KEY)
    const signer = createAccountSigner({ ...CONFIG, account })

    expect(signer.account.address).toBe(account.address)
    await expect(
      signer.send({
        to: EXECUTOR,
        data: '0x',
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000n
      })
    ).resolves.toMatchObject({ nonce: 5, txHash: expect.any(String), gas: STUB_GAS })
  })

  it('claims sequential nonces, and syncNonce re-reads the chain pending nonce over the cursor', async () => {
    let pendingNonce = '0x5'
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: () => pendingNonce,
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: signedTransactionHash
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
      eth_sendRawTransaction: signedTransactionHash
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

  it('retains the nonce and deterministic hash when the RPC loses a broadcast response', async () => {
    const rawNonces: number[] = []
    const rawTransactions: Hex[] = []
    let sendCalls = 0
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: (body: RpcBody) => {
        sendCalls += 1
        const rawTransaction = body.params?.[0] as Hex
        const nonce = parseTransaction(rawTransaction).nonce
        if (nonce === undefined) throw new Error('expected serialized tx nonce')
        rawNonces.push(nonce)
        rawTransactions.push(rawTransaction)
        if (sendCalls === 1) throw new Error('rpc timeout after broadcast')
        return signedTransactionHash(body)
      }
    })
    const { send } = createSigner({ ...CONFIG, rpcUrlFallback: 'http://localhost:8546' })
    const request = {
      to: `0x${'11'.repeat(20)}` as const,
      data: '0x' as Hex,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n
    }
    expect(await send(request)).toEqual({
      nonce: 5,
      txHash: keccak256(rawTransactions[0]!),
      gas: STUB_GAS,
      broadcastUnknown: true
    })
    expect(await send(request)).toEqual({
      nonce: 6,
      txHash: keccak256(rawTransactions[1]!),
      gas: STUB_GAS
    })
    expect(rawNonces).toEqual([5, 6])
  })

  it('throws a definitive JSON-RPC rejection and reclaims the claimed nonce', async () => {
    let sendCalls = 0
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: (body: RpcBody) => {
        sendCalls += 1
        return sendCalls === 1
          ? rpcFailure(-32000, 'insufficient funds for gas * price + value')
          : signedTransactionHash(body)
      }
    })
    const { send } = createSigner(CONFIG)
    const request = {
      to: EXECUTOR,
      data: '0x' as Hex,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n
    }

    await expect(send(request)).rejects.toBeInstanceOf(InvalidInputRpcError)
    const result = await send(request)
    expect(result.nonce).toBe(5)
    expect(result.broadcastUnknown).toBeUndefined()
  })

  it('reconciles a transaction the RPC reports as already known', async () => {
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: () => rpcFailure(-32000, 'already known')
    })
    const { send } = createSigner(CONFIG)
    const request = {
      to: EXECUTOR,
      data: '0x' as Hex,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n
    }
    const result = await send(request)

    expect(result).toMatchObject({ nonce: 5, broadcastUnknown: true })
    await expect(send(request)).resolves.toMatchObject({ nonce: 6, broadcastUnknown: true })
  })

  it('tracks the signed transaction hash when the RPC returns a different hash', async () => {
    let rawTransaction: Hex | undefined
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: (body: RpcBody) => {
        rawTransaction = body.params?.[0] as Hex
        return TXHASH
      }
    })

    const result = await createSigner(CONFIG).send({
      to: EXECUTOR,
      data: '0x',
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n
    })

    expect(result).toEqual({
      nonce: 5,
      txHash: keccak256(rawTransaction!),
      gas: STUB_GAS,
      broadcastUnknown: true
    })
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
      eth_sendRawTransaction: (body: RpcBody) => {
        sends += 1
        return signedTransactionHash(body)
      }
    })
    const { send } = createSigner({ ...CONFIG, policy: POLICY })
    const result = await send({
      to: EXECUTOR,
      data: EXECUTOR_SELECTOR,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n
    })
    expect(result).toMatchObject({ nonce: 5, txHash: expect.any(String), gas: STUB_GAS })
    expect(result.broadcastUnknown).toBeUndefined()
    expect(sends).toBe(1)
  })

  it('rejects a non-Executor target before broadcasting and rolls the nonce back', async () => {
    let sends = 0
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: (body: RpcBody) => {
        sends += 1
        return signedTransactionHash(body)
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
    ).toMatchObject({ nonce: 5, txHash: expect.any(String), gas: STUB_GAS })
  })

  it('rejects a non-exec selector before broadcasting', async () => {
    let sends = 0
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: (body: RpcBody) => {
        sends += 1
        return signedTransactionHash(body)
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

describe('sign and broadcastRaw', () => {
  afterEach(() => vi.restoreAllMocks())

  const REQUEST = {
    to: EXECUTOR,
    data: EXECUTOR_SELECTOR,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n
  } as const

  it('broadcastRaw sends exactly the bytes whose hash sign returned', async () => {
    const sent: Hex[] = []
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: (body: RpcBody) => {
        sent.push(body.params?.[0] as Hex)
        return signedTransactionHash(body)
      }
    })
    const { sign, broadcastRaw } = createSigner({ ...CONFIG, policy: POLICY })
    const signed = await sign({ ...REQUEST, nonce: 9 })
    expect(sent).toEqual([])
    expect(parseTransaction(signed.raw)).toMatchObject({ nonce: 9, to: EXECUTOR })
    expect(signed).toEqual({
      nonce: 9,
      txHash: keccak256(signed.raw),
      raw: signed.raw,
      gas: STUB_GAS
    })

    expect(await broadcastRaw(signed.raw)).toEqual({})
    expect(sent).toEqual([signed.raw])
  })

  it('sign at an explicit nonce never moves the send cursor', async () => {
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: signedTransactionHash
    })
    const { sign, send } = createSigner(CONFIG)
    await sign({ ...REQUEST, nonce: 40 })
    expect((await send(REQUEST)).nonce).toBe(5)
  })

  it('sign refuses a policy violation before signing', async () => {
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' }
    })
    const account = privateKeyToAccount(KEY)
    const signTransaction = vi.spyOn(account, 'signTransaction')
    const error = vi.fn()
    const logger = { error } as unknown as Logger
    const { sign } = createAccountSigner({ ...CONFIG, account, policy: POLICY, logger })
    const refused = sign({ ...REQUEST, data: '0xdeadbeef', nonce: 1 })
    await expect(refused).rejects.toBeInstanceOf(PolicyViolationError)
    await expect(refused).rejects.toMatchObject({ check: 'selector' })
    expect(signTransaction).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('signer.policy_violation', {
      check: 'selector',
      reason: expect.any(String),
      to: EXECUTOR,
      nonce: 1
    })
  })

  it.each([
    ['preparing', 'eth_estimateGas'],
    ['signing', 'signTransaction']
  ])('send gives its claimed nonce back when %s fails', async (_, failing) => {
    let fail = true
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: () => {
        if (fail && failing === 'eth_estimateGas') return rpcFailure(-32000, 'execution reverted')
        return '0x5208'
      },
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: signedTransactionHash
    })
    const account = privateKeyToAccount(KEY)
    if (failing === 'signTransaction') {
      vi.spyOn(account, 'signTransaction').mockRejectedValueOnce(new Error('kms unavailable'))
    }
    const { send } = createAccountSigner({ ...CONFIG, account })
    await expect(send(REQUEST)).rejects.toThrow()
    fail = false
    expect((await send(REQUEST)).nonce).toBe(5)
  })

  it('broadcastRaw throws a definitive rejection and reports an ambiguous one as unknown', async () => {
    let answer: unknown = rpcFailure(-32000, 'nonce too low')
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: () => {
        if (answer instanceof Error) throw answer
        return answer
      }
    })
    const { sign, broadcastRaw } = createSigner(CONFIG)
    const { raw } = await sign({ ...REQUEST, nonce: 3 })
    await expect(broadcastRaw(raw)).rejects.toBeInstanceOf(InvalidInputRpcError)
    answer = rpcFailure(-32000, 'already known')
    expect(await broadcastRaw(raw)).toEqual({ broadcastUnknown: true })
    answer = PROBE
    expect(await broadcastRaw(raw)).toEqual({ broadcastUnknown: true })
    answer = new Error('rpc timeout after broadcast')
    expect(await broadcastRaw(raw)).toEqual({ broadcastUnknown: true })
  })
})
