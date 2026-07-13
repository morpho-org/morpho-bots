import type { LocalAccount, TransactionSerializableEIP1559 } from 'viem'

import { createRemoteSigner, SignerPolicyError, SignerResponseError } from '@repo/signer-client'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'

import type { SignerServer } from '../src/server'

import { createSignerServer } from '../src/server'
import { account, EXECUTOR, log, testPolicy } from './helpers'

const preparedTx: TransactionSerializableEIP1559 = {
  type: 'eip1559',
  chainId: 8453,
  to: EXECUTOR,
  data: '0x00000001',
  value: 0n,
  nonce: 4,
  gas: 1_000_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 1_000_000n
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

describe('createRemoteSigner', () => {
  it('exposes only address and prepared-transaction signing', async () => {
    const signer = await createRemoteSigner({ socketPath })
    expect(signer.address).toBe(account.address)
    expect(Object.keys(signer).toSorted()).toEqual(['address', 'signPreparedTransaction'])
  })

  it('round-trips a policy-compliant prepared transaction', async () => {
    const signer = await createRemoteSigner({ socketPath })
    const signed = await signer.signPreparedTransaction(preparedTx)
    expect(signed.startsWith('0x02')).toBe(true)
  })

  it('surfaces default-deny decisions as SignerPolicyError', async () => {
    const signer = await createRemoteSigner({ socketPath })
    const promise = signer.signPreparedTransaction({ ...preparedTx, chainId: 1 })
    await expect(promise).rejects.toBeInstanceOf(SignerPolicyError)
    expect(await promise.catch((error: unknown) => error)).toMatchObject({
      code: 'policy_violation',
      check: 'chainId'
    })
  })

  it('rejects a signed response whose recovered sender differs from the handshake', async () => {
    await server.close()
    const other = privateKeyToAccount(`0x${'1'.repeat(64)}`)
    const dishonest = {
      ...account,
      signTransaction: other.signTransaction.bind(other)
    } as LocalAccount
    server = createSignerServer({ socketPath, account: dishonest, policy: testPolicy(), log })
    await server.listen()
    const signer = await createRemoteSigner({ socketPath })
    await expect(signer.signPreparedTransaction(preparedTx)).rejects.toThrow(
      /does not match signer/
    )
  })

  it('rejects a same-signer response that changes the prepared transaction', async () => {
    await server.close()
    const dishonest = {
      ...account,
      signTransaction: ((transaction: TransactionSerializableEIP1559) =>
        account.signTransaction({
          ...transaction,
          nonce: (transaction.nonce ?? 0) + 1
        })) as LocalAccount['signTransaction']
    } as LocalAccount
    server = createSignerServer({ socketPath, account: dishonest, policy: testPolicy(), log })
    await server.listen()
    const signer = await createRemoteSigner({ socketPath })
    await expect(signer.signPreparedTransaction(preparedTx)).rejects.toThrow(
      /does not match prepared transaction/
    )
  })

  it('classifies malformed serialized signer output as a response error', async () => {
    await server.close()
    const malformed = {
      ...account,
      signTransaction: (() => Promise.resolve('0x02')) as LocalAccount['signTransaction']
    } as LocalAccount
    server = createSignerServer({ socketPath, account: malformed, policy: testPolicy(), log })
    await server.listen()
    const signer = await createRemoteSigner({ socketPath })
    const error = await signer.signPreparedTransaction(preparedTx).catch(value => value)
    expect(error).toBeInstanceOf(SignerResponseError)
    expect((error as Error).message).toMatch(/invalid serialized transaction/)
  })

  it('distinguishes a dead socket from a policy response', async () => {
    const promise = createRemoteSigner({ socketPath: join(dir, 'missing.sock') })
    await expect(promise).rejects.toBeInstanceOf(Error)
    await expect(promise).rejects.not.toBeInstanceOf(SignerPolicyError)
    await expect(promise).rejects.not.toBeInstanceOf(SignerResponseError)
  })
})
