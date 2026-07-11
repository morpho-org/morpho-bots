import type { Hex, LocalAccount } from 'viem'

import { AgentPolicyError } from '@repo/signer'
import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import { withSignRetry } from '../src/engine'

const SIGNED: Hex = `0x${'ab'.repeat(32)}`

// A minimal LocalAccount whose signTransaction is the injected stub; every other method is a stub
// (withSignRetry only ever touches signTransaction).
function stubAccount(sign: () => Promise<Hex>): LocalAccount {
  return {
    address: getAddress(`0x${'11'.repeat(20)}`),
    type: 'local',
    source: 'custom',
    publicKey: '0x',
    signMessage: () => Promise.reject(new Error('unsupported')),
    signTypedData: () => Promise.reject(new Error('unsupported')),
    signTransaction: sign
  } as unknown as LocalAccount
}

const tx = { chainId: 8453, nonce: 0 } as Parameters<LocalAccount['signTransaction']>[0]

describe('withSignRetry', () => {
  it('retries ONCE on a connect-class (plain Error) failure, then returns the signature', async () => {
    let calls = 0
    const account = stubAccount(() => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('ECONNREFUSED: signer socket is dead'))
      return Promise.resolve(SIGNED)
    })
    const signed = await withSignRetry(account).signTransaction(tx)
    expect(signed).toBe(SIGNED)
    expect(calls).toBe(2)
  })

  it('never retries a typed AgentPolicyError (deterministic verdict, one attempt)', async () => {
    let calls = 0
    const account = stubAccount(() => {
      calls += 1
      return Promise.reject(new AgentPolicyError('blocked by policy', 'default_deny'))
    })
    await expect(withSignRetry(account).signTransaction(tx)).rejects.toBeInstanceOf(
      AgentPolicyError
    )
    expect(calls).toBe(1)
  })
})
