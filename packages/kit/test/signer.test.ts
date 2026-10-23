import type { Chain, Hex } from 'viem'

import { InvalidInputRpcError, keccak256, MethodNotFoundRpcError, parseTransaction } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Logger } from '../src/logger'
import type { Policy } from '../src/policy'

import { PolicyViolationError, SignWithdrawnError } from '../src/errors'
import { EXECUTOR_SELECTOR } from '../src/policy'
import { createAccountSigner } from '../src/signer'

// The `eth_estimateGas` these tests mock (0x5208).
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
  rpcUrlFallback: undefined
} as const
const signerOf = (policy = POLICY) =>
  createAccountSigner({ ...CONFIG, account: privateKeyToAccount(KEY), policy })

const PROBE: Hex = `0x${'cd'.repeat(32)}`

const REQUEST = {
  to: EXECUTOR,
  data: EXECUTOR_SELECTOR,
  value: 0n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
  mayAct: () => true
} as const

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

describe('createAccountSigner', () => {
  afterEach(() => vi.restoreAllMocks())

  it('signs as the caller-provided local account', async () => {
    mockRpc({ eth_chainId: `0x${base.id.toString(16)}`, eth_estimateGas: '0x5208' })
    const account = privateKeyToAccount(KEY)
    const signTransaction = vi.spyOn(account, 'signTransaction')
    const signer = createAccountSigner({ ...CONFIG, account, policy: POLICY })

    expect(signer.account.address).toBe(account.address)
    await signer.sign({ ...REQUEST, nonce: 5 })
    expect(signTransaction).toHaveBeenCalledOnce()
  })

  it('getBaseFee returns the latest base fee', async () => {
    mockRpc({ eth_getBlockByNumber: { baseFeePerGas: '0x7' } })
    expect(await signerOf().getBaseFee()).toBe(7n)
  })

  it('getBaseFee throws when the chain reports no base fee', async () => {
    mockRpc({ eth_getBlockByNumber: {} })
    await expect(signerOf().getBaseFee()).rejects.toThrow(/baseFeePerGas/)
  })

  it('signs a policy-compliant exec call', async () => {
    mockRpc({ eth_chainId: `0x${base.id.toString(16)}`, eth_estimateGas: '0x5208' })
    const signed = await signerOf(POLICY).sign({ ...REQUEST, nonce: 5 })
    expect(parseTransaction(signed.raw)).toMatchObject({ nonce: 5, to: EXECUTOR, gas: STUB_GAS })
  })

  it('asks mayAct after preparation and policy, and signs nothing it refuses', async () => {
    let authorized = true
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_estimateGas: () => {
        authorized = false
        return '0x5208'
      }
    })
    const account = privateKeyToAccount(KEY)
    const signTransaction = vi.spyOn(account, 'signTransaction')
    const { sign } = createAccountSigner({ ...CONFIG, account, policy: POLICY })
    await expect(sign({ ...REQUEST, nonce: 5, mayAct: () => authorized })).rejects.toBeInstanceOf(
      SignWithdrawnError
    )
    expect(signTransaction).not.toHaveBeenCalled()
  })

  it('refuses to sign when the node fills in fees other than those requested', async () => {
    const account = privateKeyToAccount(KEY)
    for (const filled of [
      { maxFeePerGas: '0x0', maxPriorityFeePerGas: '0x0', nonce: '0x5' },
      { gasPrice: '0xe8d4a51000', nonce: '0x5' }
    ]) {
      mockRpc({
        eth_chainId: `0x${base.id.toString(16)}`,
        eth_fillTransaction: {
          raw: '0x',
          tx: {
            from: account.address,
            to: EXECUTOR,
            input: EXECUTOR_SELECTOR,
            value: '0x0',
            gas: '0x5208',
            ...filled
          }
        }
      })
      const signTransaction = vi.spyOn(account, 'signTransaction')
      const { sign } = createAccountSigner({ ...CONFIG, account, policy: POLICY })
      await expect(sign({ ...REQUEST, nonce: 5 })).rejects.toThrow('differs from the one requested')
      expect(signTransaction).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    }
  })

  it.each([
    { name: 'target', changed: { to: `0x${'99'.repeat(20)}` } },
    { name: 'calldata', changed: { data: '0xdeadbeef' } },
    { name: 'value', changed: { value: 1n } }
  ])('refuses to sign when preparation changes the requested $name', async ({ changed }) => {
    const account = privateKeyToAccount(KEY)
    const chain = {
      ...base,
      prepareTransactionRequest: [
        async request => ({ ...request, ...changed }),
        { runAt: ['afterFillParameters'] }
      ]
    } as Chain
    const signTransaction = vi.spyOn(account, 'signTransaction')
    const { sign } = createAccountSigner({ ...CONFIG, chain, account, policy: POLICY })
    await expect(sign({ ...REQUEST, nonce: 5, gas: STUB_GAS })).rejects.toThrow(
      'the prepared transaction differs from the one requested'
    )
    expect(signTransaction).not.toHaveBeenCalled()
  })

  it('refuses to sign a prepared transaction without a gas limit', async () => {
    const account = privateKeyToAccount(KEY)
    const chain = {
      ...base,
      prepareTransactionRequest: [
        async request => {
          const { gas: _, ...withoutGas } = request
          return withoutGas
        },
        { runAt: ['afterFillParameters'] }
      ]
    } as Chain
    const signTransaction = vi.spyOn(account, 'signTransaction')
    const { sign } = createAccountSigner({ ...CONFIG, chain, account, policy: POLICY })
    await expect(sign({ ...REQUEST, nonce: 5, gas: STUB_GAS })).rejects.toThrow(
      'the prepared transaction has no gas limit'
    )
    expect(signTransaction).not.toHaveBeenCalled()
  })

  it('does not ask mayAct for a transaction the policy refuses', async () => {
    mockRpc({ eth_chainId: `0x${base.id.toString(16)}`, eth_estimateGas: '0x5208' })
    const mayAct = vi.fn(() => true)
    await expect(
      signerOf().sign({ ...REQUEST, to: `0x${'99'.repeat(20)}`, nonce: 5, mayAct })
    ).rejects.toBeInstanceOf(PolicyViolationError)
    expect(mayAct).not.toHaveBeenCalled()
  })

  it('refuses a non-Executor target before signing', async () => {
    mockRpc({ eth_chainId: `0x${base.id.toString(16)}`, eth_estimateGas: '0x5208' })
    await expect(
      signerOf(POLICY).sign({ ...REQUEST, to: `0x${'99'.repeat(20)}`, nonce: 5 })
    ).rejects.toMatchObject({ check: 'target' })
  })
})

describe('sign and broadcastRaw', () => {
  afterEach(() => vi.restoreAllMocks())

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
    const { sign, broadcastRaw } = signerOf(POLICY)
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
    const { sign, broadcastRaw } = signerOf()
    const { raw } = await sign({ ...REQUEST, nonce: 3 })
    await expect(broadcastRaw(raw)).rejects.toBeInstanceOf(InvalidInputRpcError)
    answer = rpcFailure(-32000, 'already known')
    expect(await broadcastRaw(raw)).toEqual({ broadcastUnknown: true })
    answer = PROBE
    expect(await broadcastRaw(raw)).toEqual({ broadcastUnknown: true })
    answer = new Error('rpc timeout after broadcast')
    expect(await broadcastRaw(raw)).toEqual({ broadcastUnknown: true })
  })

  it('broadcastRaw sends once, to the primary only, when a fallback is configured', async () => {
    mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_estimateGas: '0x5208',
      eth_sendRawTransaction: () => {
        throw new Error('rpc timeout after broadcast')
      }
    })
    const fetchSpy = vi.mocked(globalThis.fetch)
    const { sign, broadcastRaw } = createAccountSigner({
      ...CONFIG,
      rpcUrlFallback: 'http://localhost:8546',
      account: privateKeyToAccount(KEY),
      policy: POLICY
    })
    const { raw } = await sign({ ...REQUEST, nonce: 5 })
    fetchSpy.mockClear()

    expect(await broadcastRaw(raw)).toEqual({ broadcastUnknown: true })
    const urls = fetchSpy.mock.calls.map(([url]) => new URL(url instanceof Request ? url.url : url))
    expect(urls.map(url => url.href)).toEqual([new URL(CONFIG.rpcUrl).href])
  })
})
