import type { Hex, TransactionSerializedEIP1559 } from 'viem'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress, parseTransaction, recoverTransactionAddress } from 'viem'

import type { SignerServer } from '../src/server'

import { createSignerServer, MAX_LINE_BYTES } from '../src/server'
import { account, EXECUTOR, log, testPolicy } from './helpers'

function wire(overrides: Record<string, unknown> = {}) {
  return {
    type: 'eip1559',
    chainId: 8453,
    to: EXECUTOR,
    data: '0x',
    value: '0',
    nonce: 7,
    gas: '1000000',
    maxFeePerGas: '1000000000',
    maxPriorityFeePerGas: '1000000',
    ...overrides
  }
}

// One request line in, one response line out over a fresh connection.
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

let dir: string
let socketPath: string
let server: SignerServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 's-'))
  socketPath = join(dir, 'x.sock')
  server = createSignerServer({ socketPath, account, policy: testPolicy(), log })
  await server.listen()
})

afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('createSignerServer', () => {
  it('answers ping and address', async () => {
    expect(await rpc(socketPath, { v: 1, id: '1', method: 'ping' })).toEqual({
      v: 1,
      id: '1',
      result: { pong: true }
    })
    const addr = await rpc(socketPath, { v: 1, id: '2', method: 'address' })
    expect(addr.result).toEqual({ address: account.address })
  })

  it('signs a policy-compliant tx recoverable to the account, fields intact', async () => {
    const response = await rpc(socketPath, {
      v: 1,
      id: '3',
      method: 'signTransaction',
      params: wire()
    })
    const result = response.result as { signedTransaction: TransactionSerializedEIP1559 }
    expect(
      await recoverTransactionAddress({ serializedTransaction: result.signedTransaction })
    ).toBe(account.address)
    const parsed = parseTransaction(result.signedTransaction)
    expect(parsed.chainId).toBe(8453)
    expect(parsed.nonce).toBe(7)
    expect(parsed.gas).toBe(1000000n)
    expect(getAddress(parsed.to ?? '0x')).toBe(EXECUTOR)
  })

  it('signs the same nonce twice with different fees (RBF, stateless policy)', async () => {
    const first = await rpc(socketPath, {
      v: 1,
      id: 'a',
      method: 'signTransaction',
      params: wire({ nonce: 9, maxFeePerGas: '1000000000' })
    })
    const second = await rpc(socketPath, {
      v: 1,
      id: 'b',
      method: 'signTransaction',
      params: wire({ nonce: 9, maxFeePerGas: '2000000000' })
    })
    const firstTx = (first.result as { signedTransaction: Hex }).signedTransaction
    const secondTx = (second.result as { signedTransaction: Hex }).signedTransaction
    expect(firstTx).not.toBe(secondTx)
    expect(parseTransaction(firstTx).nonce).toBe(9)
    expect(parseTransaction(secondTx).nonce).toBe(9)
    expect(parseTransaction(secondTx).maxFeePerGas).toBe(2000000000n)
  })

  it('rejects a disallowed tx with policy_violation carrying rule and check', async () => {
    const response = await rpc(socketPath, {
      v: 1,
      id: '4',
      method: 'signTransaction',
      params: wire({ chainId: 1 })
    })
    expect(response.error).toMatchObject({
      code: 'policy_violation',
      rule: 'test-rule',
      check: 'chainId'
    })
  })

  it('rejects an oversize line with bad_request and closes the connection', async () => {
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
    expect(response.error).toMatchObject({ code: 'bad_request' })
  })

  it('handles two concurrent connections', async () => {
    const [a, b] = await Promise.all([
      rpc(socketPath, { v: 1, id: 'c1', method: 'address' }),
      rpc(socketPath, { v: 1, id: 'c2', method: 'address' })
    ])
    expect(a.result).toEqual({ address: account.address })
    expect(b.result).toEqual({ address: account.address })
  })

  it('creates the socket with 0600 permissions', () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)
  })

  it('close() unlinks the socket file (idempotently)', async () => {
    expect(existsSync(socketPath)).toBe(true)
    await server.close()
    expect(existsSync(socketPath)).toBe(false)
    await server.close()
  })
})
