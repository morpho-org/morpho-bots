import type { Hex, TransactionSerializedEIP1559 } from 'viem'

import { MAX_LINE_BYTES } from '@repo/bot-kit'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import type { Engine } from '../src/engine'
import type { QueuedServer } from '../src/server'

import { resolveConfig } from '../src/config'
import { createEngine } from '../src/engine'
import { createQueuedServer } from '../src/server'

// Throwaway well-known test key (anvil account #0) — never used to hold funds.
const KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ACCOUNT = privateKeyToAccount(KEY)
const EXECUTOR = getAddress(`0x${'22'.repeat(20)}`)
const noop = () => undefined
const LOG = { debug: noop, info: noop, warn: noop, error: noop }

type RpcBody = { id: number; method: string; params?: unknown[] }

// Canned JSON-RPC over a spied global fetch, capturing raw txs handed to eth_sendRawTransaction. The
// node:net socket transport is untouched by the fetch spy.
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

const ARMED_RPC = {
  eth_chainId: `0x${base.id.toString(16)}`,
  eth_getTransactionCount: '0x5',
  eth_estimateGas: '0x5208',
  eth_call: '0x', // re-sim succeeds (no revert)
  eth_getBlockByNumber: { number: '0x64', baseFeePerGas: '0x7' },
  eth_sendRawTransaction: `0x${'ab'.repeat(32)}`,
  eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x65', logs: [] }
}

// One request line in, one response line out over a fresh connection (mirrors signer/test/server).
function rpc(socketPath: string, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const idx = buffer.indexOf('\n')
      if (idx === -1) return
      socket.destroy()
      resolve(JSON.parse(buffer.slice(0, idx)))
    })
    socket.on('error', reject)
  })
}

// Several requests down ONE connection; collects that many response lines (order preserved).
function rpcMany(socketPath: string, requests: unknown[]): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const out: Record<string, unknown>[] = []
    let buffer = ''
    socket.on('connect', () => socket.write(requests.map(r => JSON.stringify(r)).join('\n') + '\n'))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        out.push(JSON.parse(buffer.slice(0, idx)))
        buffer = buffer.slice(idx + 1)
        if (out.length === requests.length) {
          socket.destroy()
          resolve(out)
          return
        }
        idx = buffer.indexOf('\n')
      }
    })
    socket.on('error', reject)
  })
}

const txRecord = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  kind: 'tx',
  id: 'blue:liquidate:0xborrower',
  domain: 'blue',
  op: 'liquidate',
  chainId: base.id,
  at: new Date().toISOString(),
  summary: 'blue liquidate',
  to: EXECUTOR,
  data: '0x',
  simulated: { status: 'ok', block: 100 },
  ...overrides
})

let dir: string
let socketPath: string
let server: QueuedServer | null
let engine: Engine | null

function makeConfig(opts: { dryRun?: boolean } = {}) {
  return resolveConfig({
    env: {
      RPC_URL: 'http://localhost:8545',
      ...(opts.dryRun ? {} : { LIQUIDATOR_PRIVATE_KEY: KEY })
    },
    chain: base,
    chainId: String(base.id),
    opts: { socket: socketPath, ...(opts.dryRun ? { dryRun: true } : {}) },
    home: dir
  })
}

async function start(opts: { dryRun?: boolean } = {}) {
  const config = makeConfig(opts)
  engine = createEngine({
    config,
    account: opts.dryRun ? null : ACCOUNT,
    logger: LOG,
    home: dir
  })
  await engine.start()
  server = createQueuedServer({ socketPath, engine, log: LOG })
  await server.listen()
}

beforeEach(() => {
  // Short temp dir so the Unix sun_path stays under the ~104-byte OS cap on macOS.
  dir = mkdtempSync(join(tmpdir(), 'q-srv-'))
  socketPath = join(dir, 'q.sock')
  server = null
  engine = null
})

afterEach(async () => {
  if (engine) await engine.shutdown()
  if (server) await server.close()
  rmSync(dir, { recursive: true, force: true })
  mock.restore()
})

describe('createQueuedServer', () => {
  it('answers ping and status (armed)', async () => {
    mockRpc(ARMED_RPC)
    await start()
    expect(await rpc(socketPath, { v: 1, id: '1', method: 'ping' })).toEqual({
      v: 1,
      id: '1',
      result: { pong: true }
    })
    const status = await rpc(socketPath, { v: 1, id: '2', method: 'status' })
    expect(status.result).toEqual({
      chainId: base.id,
      address: ACCOUNT.address,
      armed: true,
      pending: 0,
      wireVersion: 1
    })
  })

  it('ingests a tx: submitted ack + a raw tx broadcast to the send endpoint', async () => {
    const { rawTxs } = mockRpc(ARMED_RPC)
    await start()
    const response = await rpc(socketPath, {
      v: 1,
      id: 'r1',
      method: 'ingest',
      params: { record: txRecord() }
    })
    const outcome = (response.result as { outcome: Record<string, unknown> }).outcome
    expect(outcome.status).toBe('submitted')
    expect(outcome.kind).toBe('outcome')
    expect(outcome.txHash).toBeDefined()
    expect(rawTxs).toHaveLength(1)
  })

  it('ingests an outcome: records backoff (persisted to the state file), returns {}', async () => {
    mockRpc(ARMED_RPC)
    await start()
    const response = await rpc(socketPath, {
      v: 1,
      id: 'o1',
      method: 'ingest',
      params: {
        record: {
          v: 1,
          kind: 'outcome',
          id: 'blue:liquidate:0xbackedoff',
          domain: 'blue',
          op: 'liquidate',
          chainId: base.id,
          at: new Date().toISOString(),
          summary: 'x',
          status: 'sim_reverted'
        }
      }
    })
    expect(response.result).toEqual({ outcome: undefined })
    const state = JSON.parse(readFileSync(join(dir, 'blue', 'queue', `${base.id}.json`), 'utf8'))
    const labels = (state.backoff as [string, unknown][]).map(([label]) => label)
    expect(labels).toContain('blue:liquidate:0xbackedoff')
  })

  it('keeps the connection alive after a chain_mismatch (request-scoped error)', async () => {
    mockRpc(ARMED_RPC)
    await start()
    const [mismatch, pong] = await rpcMany(socketPath, [
      { v: 1, id: 'm', method: 'ingest', params: { record: txRecord({ chainId: 1 }) } },
      { v: 1, id: 'p', method: 'ping' }
    ])
    expect((mismatch!.error as { code: string }).code).toBe('chain_mismatch')
    expect(pong!.result).toEqual({ pong: true })
  })

  it('warns+skips an unknown-domain record as bad_request, connection survives', async () => {
    mockRpc(ARMED_RPC)
    await start()
    const [bad, pong] = await rpcMany(socketPath, [
      { v: 1, id: 'b', method: 'ingest', params: { record: txRecord({ domain: 'ethereum' }) } },
      { v: 1, id: 'p', method: 'ping' }
    ])
    expect((bad!.error as { code: string }).code).toBe('bad_request')
    expect(pong!.result).toEqual({ pong: true })
  })

  it('rejects a record from a newer wire version as unsupported_version', async () => {
    mockRpc(ARMED_RPC)
    await start()
    const response = await rpc(socketPath, {
      v: 1,
      id: 'v',
      method: 'ingest',
      params: { record: txRecord({ v: 999 }) }
    })
    expect((response.error as { code: string }).code).toBe('unsupported_version')
  })

  it('rejects an oversize line with bad_request and closes the connection', async () => {
    mockRpc(ARMED_RPC)
    await start()
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = connect(socketPath)
      let buffer = ''
      socket.on('connect', () =>
        socket.write(`{"v":1,"id":"big","junk":"${'x'.repeat(MAX_LINE_BYTES + 10)}`)
      )
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8')
        const idx = buffer.indexOf('\n')
        if (idx === -1) return
        socket.destroy()
        resolve(JSON.parse(buffer.slice(0, idx)))
      })
      socket.on('error', reject)
    })
    expect((response.error as { code: string }).code).toBe('bad_request')
  })

  it('dry-run: would_submit ack, ZERO eth_sendRawTransaction, no state file written', async () => {
    const { rawTxs } = mockRpc(ARMED_RPC)
    await start({ dryRun: true })
    const status = await rpc(socketPath, { v: 1, id: 's', method: 'status' })
    expect(status.result).toMatchObject({ armed: false, address: null })

    const response = await rpc(socketPath, {
      v: 1,
      id: 'd1',
      method: 'ingest',
      params: { record: txRecord() }
    })
    const outcome = (response.result as { outcome: Record<string, unknown> }).outcome
    expect(outcome.status).toBe('would_submit')
    expect(rawTxs).toHaveLength(0)
    expect(existsSync(join(dir, 'blue', 'queue', `${base.id}.json`))).toBe(false)
  })

  it('creates the socket with 0600 permissions', async () => {
    mockRpc(ARMED_RPC)
    await start()
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)
  })

  it('close() unlinks the socket file (idempotently)', async () => {
    mockRpc(ARMED_RPC)
    await start()
    expect(existsSync(socketPath)).toBe(true)
    await server!.close()
    expect(existsSync(socketPath)).toBe(false)
    await server!.close()
    server = null
  })
})
