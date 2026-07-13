import type { Hex, TransactionSerializedEIP1559 } from 'viem'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress, parseTransaction, recoverTransactionAddress } from 'viem'

import type { SignerServer } from '../src/server'

import { createSignerServer, MAX_LINE_BYTES } from '../src/server'
import { account, captureLog, EXECUTOR, testPolicy } from './helpers'

function wire(overrides: Record<string, unknown> = {}) {
  return {
    type: 'eip1559',
    chainId: 8453,
    to: EXECUTOR,
    data: '0x00000001',
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
let log: ReturnType<typeof captureLog>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 's-'))
  socketPath = join(dir, 'x.sock')
  log = captureLog()
  server = createSignerServer({ socketPath, account, policy: testPolicy(), log })
  await server.listen()
})

afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('createSignerServer', () => {
  it('answers the address identity/readiness handshake', async () => {
    const addr = await rpc(socketPath, { v: 3, method: 'address' })
    expect(addr.ok).toBe(true)
    expect(addr.result).toEqual({ address: account.address })
  })

  it('signs a policy-compliant tx recoverable to the account, fields intact', async () => {
    const response = await rpc(socketPath, {
      v: 3,
      method: 'signTransaction',
      transaction: wire()
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
      v: 3,
      method: 'signTransaction',
      transaction: wire({ nonce: 9, maxFeePerGas: '1000000000' })
    })
    const second = await rpc(socketPath, {
      v: 3,
      method: 'signTransaction',
      transaction: wire({ nonce: 9, maxFeePerGas: '2000000000' })
    })
    const firstTx = (first.result as { signedTransaction: Hex }).signedTransaction
    const secondTx = (second.result as { signedTransaction: Hex }).signedTransaction
    expect(firstTx).not.toBe(secondTx)
    expect(parseTransaction(firstTx).nonce).toBe(9)
    expect(parseTransaction(secondTx).nonce).toBe(9)
    expect(parseTransaction(secondTx).maxFeePerGas).toBe(2000000000n)
  })

  it('rejects a disallowed tx with a typed policy check', async () => {
    const response = await rpc(socketPath, {
      v: 3,
      method: 'signTransaction',
      transaction: wire({ chainId: 1 })
    })
    expect(response.error).toMatchObject({
      code: 'policy_violation',
      check: 'chainId'
    })
  })

  it('logs signer.rejected with the failing check, chainId, to, and nonce', async () => {
    await rpc(socketPath, {
      v: 3,
      method: 'signTransaction',
      transaction: wire({ chainId: 1, nonce: 42 })
    })
    expect(log.events).toContainEqual({
      level: 'warn',
      event: 'signer.rejected',
      fields: { check: 'chainId', chainId: 1, to: EXECUTOR, nonce: 42 }
    })
  })

  it('rejects oversize lines with or without a newline in the final chunk', async () => {
    const request = (newline: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = connect(socketPath)
        let buffer = ''
        socket.on('connect', () =>
          socket.write(`{"v":3,"junk":"${'x'.repeat(MAX_LINE_BYTES + 10)}${newline}`)
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

    for (const newline of ['', '\n']) {
      const response = await request(newline)
      expect(response.error).toMatchObject({
        code: 'bad_request',
        message: 'request line too large'
      })
    }
  })

  it('handles two concurrent connections', async () => {
    const [a, b] = await Promise.all([
      rpc(socketPath, { v: 3, method: 'address' }),
      rpc(socketPath, { v: 3, method: 'address' })
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
