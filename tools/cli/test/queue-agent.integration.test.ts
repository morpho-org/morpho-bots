import type { SignerServer } from '@repo/signer'
import type { Hex, TransactionSerializedEIP1559 } from 'viem'

import { createLogger, createPendingQueue, createSigner, initialFees } from '@repo/bot-kit'
import { createAgentAccount, createSignerServer, parsePolicy } from '@repo/signer'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress, parseGwei, parseTransaction, recoverTransactionAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

// End-to-end keyless queue: an in-process signing agent holds the key, the queue reaches it through
// a real Unix socket via `createAgentAccount`, `createSigner({account})` wraps it, and
// `createPendingQueue` drives the same submit/RBF path the CLI uses — proving broadcast raw txs are
// signed by the daemon key without the queue ever seeing it.

// Throwaway well-known test key (anvil account #0) — never used to hold funds.
const KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DAEMON = privateKeyToAccount(KEY)
const EXECUTOR = getAddress(`0x${'22'.repeat(20)}`)
const MAX_FEE_WEI = parseGwei('300')
const noop = () => undefined
const silentLog = { info: noop, warn: noop, error: noop }

function policy() {
  // No `selectors` — the queue submits arbitrary Executor calldata (`0x` here), and the load-bearing
  // checks are to/value/fee/gas. Matches the `to == Executor`, `value == 0` policy shape.
  return parsePolicy({
    version: 1,
    rules: [
      {
        name: 'test-executor',
        chainIds: [base.id],
        to: [EXECUTOR],
        maxFeePerGasWei: MAX_FEE_WEI.toString(),
        maxGasLimit: '15000000'
      }
    ]
  })
}

type RpcBody = { id: number; method: string; params?: unknown[] }

// Canned JSON-RPC over a spied global fetch, capturing the raw txs handed to eth_sendRawTransaction.
// The socket transport is node:net, untouched by the fetch spy.
function mockRpc(results: Record<string, unknown>) {
  const rawTxs: TransactionSerializedEIP1559[] = []
  const handler = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
    const body = JSON.parse(init?.body ?? '{}') as RpcBody
    if (body.method === 'eth_sendRawTransaction') {
      rawTxs.push(body.params?.[0] as TransactionSerializedEIP1559)
    }
    if (!(body.method in results)) throw new Error(`unmocked RPC method ${body.method}`)
    const value = results[body.method]
    const result = typeof value === 'function' ? await value(body) : value
    return Response.json({ jsonrpc: '2.0', id: body.id, result })
  }
  spyOn(globalThis, 'fetch').mockImplementation(handler as unknown as typeof fetch)
  return { rawTxs }
}

let dir: string
let socketPath: string
let server: SignerServer

beforeEach(async () => {
  // Short temp dir so the Unix sun_path stays under the ~104-byte OS cap on macOS.
  dir = mkdtempSync(join(tmpdir(), 's-'))
  socketPath = join(dir, 'q.sock')
  server = createSignerServer({ socketPath, account: DAEMON, policy: policy(), log: silentLog })
  await server.listen()
})

afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
  mock.restore()
})

async function agentSigner() {
  const account = await createAgentAccount({ socketPath })
  return createSigner({
    chain: base,
    rpcUrl: 'http://localhost:8545',
    rpcUrlFallback: undefined,
    sendRpcUrl: undefined,
    account
  })
}

describe('keyless queue via the signing agent', () => {
  it('signs a submit through the agent (raw tx recovers to the daemon key) and confirms it', async () => {
    const hash: Hex = `0x${'ab'.repeat(32)}`
    const { rawTxs } = mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: hash,
      eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x65', logs: [] }
    })
    const signer = await agentSigner()
    expect(signer.account.address).toBe(DAEMON.address)

    const settled: string[] = []
    const queue = createPendingQueue({
      send: signer.send,
      getReceipt: signer.getReceipt,
      getBaseFee: signer.getBaseFee,
      syncNonce: signer.syncNonce,
      maxFeeWei: MAX_FEE_WEI,
      logger: createLogger('error'),
      onSettled: s => settled.push(s.status)
    })

    const fees = initialFees(7n, MAX_FEE_WEI)
    const result = await queue.submit({
      request: { to: EXECUTOR, data: '0x' },
      label: 'blue:liquidate:0xborrower',
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      blockNumber: 100n
    })
    expect(result.submitted).toBe(true)

    // The broadcast raw tx was signed by the daemon key — the queue never held it.
    expect(rawTxs).toHaveLength(1)
    const recovered = await recoverTransactionAddress({ serializedTransaction: rawTxs[0]! })
    expect(getAddress(recovered)).toBe(DAEMON.address)

    await queue.onBlock(101n)
    expect(settled).toEqual(['confirmed'])
  })

  it('bumps a stuck tx by re-signing the SAME nonce with higher fees through the agent', async () => {
    let sends = 0
    const { rawTxs } = mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: { baseFeePerGas: '0x7' },
      eth_sendRawTransaction: () => {
        sends += 1
        return `0x${sends.toString(16).padStart(64, '0')}`
      },
      // Never confirms → after `stuckBlocks` the queue bumps and replaces.
      eth_getTransactionReceipt: null
    })
    const signer = await agentSigner()
    const queue = createPendingQueue({
      send: signer.send,
      getReceipt: signer.getReceipt,
      getBaseFee: signer.getBaseFee,
      syncNonce: signer.syncNonce,
      maxFeeWei: MAX_FEE_WEI,
      logger: createLogger('error')
    })

    const fees = initialFees(7n, MAX_FEE_WEI)
    await queue.submit({
      request: { to: EXECUTOR, data: '0x' },
      label: 'blue:liquidate:0xborrower',
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      blockNumber: 100n
    })
    // Far enough past submit block to trip stuck-detection (default stuckBlocks = 4).
    await queue.onBlock(110n)

    expect(rawTxs).toHaveLength(2)
    const first = parseTransaction(rawTxs[0]!)
    const second = parseTransaction(rawTxs[1]!)
    // Same nonce, strictly higher fee — a valid EIP-1559 replacement, re-signed by the daemon.
    expect(second.nonce).toBe(first.nonce)
    expect(second.maxFeePerGas!).toBeGreaterThan(first.maxFeePerGas!)
    for (const raw of rawTxs) {
      expect(getAddress(await recoverTransactionAddress({ serializedTransaction: raw }))).toBe(
        DAEMON.address
      )
    }
  })
})
