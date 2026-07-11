import type { TransactionSerializableEIP1559, TransactionSerializedEIP1559 } from 'viem'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recoverTransactionAddress } from 'viem'

import type { SignerServer } from '../src/server'

import { AgentPolicyError, createAgentAccount } from '../src/client'
import { createSignerServer } from '../src/server'
import { account, EXECUTOR, log, testPolicy } from './helpers'

const preparedTx: TransactionSerializableEIP1559 = {
  type: 'eip1559',
  chainId: 8453,
  to: EXECUTOR,
  data: '0x',
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

describe('createAgentAccount', () => {
  it('handshakes and exposes the agent address', async () => {
    const agent = await createAgentAccount({ socketPath })
    expect(agent.address).toBe(account.address)
  })

  it('round-trips a signTransaction through the socket, recoverable to the agent', async () => {
    const agent = await createAgentAccount({ socketPath })
    const signed = (await agent.signTransaction(preparedTx)) as TransactionSerializedEIP1559
    expect(await recoverTransactionAddress({ serializedTransaction: signed })).toBe(account.address)
  })

  it('surfaces a policy rejection as AgentPolicyError', async () => {
    const agent = await createAgentAccount({ socketPath })
    const promise = agent.signTransaction({ ...preparedTx, chainId: 1 })
    await expect(promise).rejects.toBeInstanceOf(AgentPolicyError)
    const error = await promise.catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'policy_violation', rule: 'test-rule', check: 'chainId' })
  })

  it('rejects signMessage and signTypedData as unsupported stubs', async () => {
    const agent = await createAgentAccount({ socketPath })
    await expect(agent.signMessage({ message: 'hi' })).rejects.toThrow(/signMessage/)
    await expect(
      agent.signTypedData({
        domain: { name: 'x' },
        types: { Foo: [{ name: 'a', type: 'uint256' }] },
        primaryType: 'Foo',
        message: { a: 1n }
      })
    ).rejects.toThrow(/signTypedData/)
  })

  it('throws a plain error when the socket is dead', async () => {
    const dead = join(dir, 'nope.sock')
    await expect(createAgentAccount({ socketPath: dead })).rejects.toBeInstanceOf(Error)
    await expect(createAgentAccount({ socketPath: dead })).rejects.not.toBeInstanceOf(
      AgentPolicyError
    )
  })
})
