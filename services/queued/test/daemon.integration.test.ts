import type { SignerServer } from '@repo/signer'
import type { Hex, TransactionSerializedEIP1559 } from 'viem'

import { createAgentAccount, createSignerServer, parsePolicy } from '@repo/signer'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress, parseGwei, parseTransaction, recoverTransactionAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import type { Engine } from '../src/engine'

import { resolveConfig } from '../src/config'
import { createEngine } from '../src/engine'

// End-to-end KEYLESS daemon: an in-process signing agent holds the key, the engine reaches it through
// a real Unix socket via `createAgentAccount`, and the engine drives the same re-sim → submit → RBF
// path the daemon runs — proving broadcast raw txs are signed by the agent key the engine never holds.

const KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DAEMON = privateKeyToAccount(KEY)
const EXECUTOR = getAddress(`0x${'22'.repeat(20)}`)
const MAX_FEE_WEI = parseGwei('300')
const noop = () => undefined
const LOG = { debug: noop, info: noop, warn: noop, error: noop }

function policy() {
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

const txRecord = () => ({
  v: 1,
  kind: 'tx' as const,
  id: 'blue:liquidate:0xborrower',
  domain: 'blue',
  op: 'liquidate',
  chainId: base.id,
  at: new Date().toISOString(),
  summary: 'blue liquidate',
  to: EXECUTOR,
  data: '0x',
  simulated: { status: 'ok', block: 100 }
})

let dir: string
let signerSock: string
let signer: SignerServer
let engine: Engine | null

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'q-int-'))
  signerSock = join(dir, 's.sock')
  signer = createSignerServer({
    socketPath: signerSock,
    account: DAEMON,
    policy: policy(),
    log: LOG
  })
  await signer.listen()
  engine = null
})

afterEach(async () => {
  if (engine) await engine.shutdown()
  await signer.close()
  rmSync(dir, { recursive: true, force: true })
  mock.restore()
})

async function armedEngine() {
  const account = await createAgentAccount({ socketPath: signerSock })
  const config = resolveConfig({
    env: { RPC_URL: 'http://localhost:8545', SIGNER_SOCKET: signerSock },
    chain: base,
    chainId: String(base.id),
    opts: { socket: join(dir, 'q.sock') },
    home: dir
  })
  const e = createEngine({ config, account, logger: LOG, home: dir })
  await e.start()
  return e
}

describe('keyless queued daemon via the signing agent', () => {
  it('ingests a tx: the broadcast raw tx recovers to the agent key (the engine never held it)', async () => {
    const { rawTxs } = mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_call: '0x',
      eth_getBlockByNumber: { number: '0x64', baseFeePerGas: '0x7' },
      eth_sendRawTransaction: `0x${'ab'.repeat(32)}`,
      eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x65', logs: [] }
    })
    engine = await armedEngine()
    expect(engine.status().address).toBe(DAEMON.address)

    const { outcome } = await engine.ingest(txRecord())
    expect(outcome?.status).toBe('submitted')
    expect(rawTxs).toHaveLength(1)
    const recovered = await recoverTransactionAddress({ serializedTransaction: rawTxs[0]! })
    expect(getAddress(recovered)).toBe(DAEMON.address)
  })

  it('bumps a stuck tx on sweep: same nonce, higher fee, re-signed by the agent key', async () => {
    let blockNum = 0x64
    const { rawTxs } = mockRpc({
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_getTransactionCount: '0x5',
      eth_estimateGas: '0x5208',
      eth_call: '0x',
      eth_getBlockByNumber: () => ({ number: `0x${blockNum.toString(16)}`, baseFeePerGas: '0x7' }),
      eth_sendRawTransaction: (body: RpcBody) => `0x${String(body.id).padStart(64, '0')}`,
      eth_getTransactionReceipt: null // never confirms → after stuckBlocks the sweep bumps + replaces.
    })
    engine = await armedEngine()

    await engine.ingest(txRecord())
    // Advance the head well past submit + stuckBlocks (default 4), then sweep.
    blockNum = 0x6e // 110
    await engine.tick()

    expect(rawTxs.length).toBeGreaterThanOrEqual(2)
    const first = parseTransaction(rawTxs[0]!)
    const last = parseTransaction(rawTxs[rawTxs.length - 1]!)
    expect(last.nonce).toBe(first.nonce)
    expect(last.maxFeePerGas!).toBeGreaterThan(first.maxFeePerGas!)
    for (const raw of rawTxs) {
      expect(getAddress(await recoverTransactionAddress({ serializedTransaction: raw }))).toBe(
        DAEMON.address
      )
    }
  })
})
