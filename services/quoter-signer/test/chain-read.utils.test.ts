import { describe, expect, it, vi } from 'vitest'

import type { ChainReadTransport } from '../src/chain-read.utils'
import type { RpcReadOperation } from '../src/rpc-unavailable.error'

import { readMakerPendingNonce } from '../src/chain-read.utils'
import { RpcChainMismatchError } from '../src/rpc-chain-mismatch.error'
import { RpcUnavailableError } from '../src/rpc-unavailable.error'
import { FIXTURE_MAKER } from './policy-fixture'

const config = { url: 'https://rpc.example' }
const expected = { chainId: 8453, maker: FIXTURE_MAKER } as const

const transport = (overrides: Partial<ChainReadTransport> = {}): ChainReadTransport => ({
  chainId: async () => 8453,
  pendingNonce: async () => 7,
  ...overrides
})

const expectUnavailable = async (attempt: Promise<unknown>, operation: RpcReadOperation) => {
  await expect(attempt).rejects.toMatchObject({
    name: 'RpcUnavailableError',
    operation,
    retryable: true
  })
}

describe('readMakerPendingNonce', () => {
  it('verifies the chain id before trusting the pending nonce', async () => {
    const pendingNonce = vi.fn(async () => 7)

    await expect(
      readMakerPendingNonce(config, expected, transport({ pendingNonce }))
    ).resolves.toBe(7)
    expect(pendingNonce).toHaveBeenCalledExactlyOnceWith(config, FIXTURE_MAKER)
  })

  it('fails closed terminally when the endpoint serves another chain, reading no nonce', async () => {
    const pendingNonce = vi.fn(async () => 7)

    await expect(
      readMakerPendingNonce(config, expected, transport({ chainId: async () => 1, pendingNonce }))
    ).rejects.toMatchObject({ name: 'RpcChainMismatchError', retryable: false })
    expect(pendingNonce).not.toHaveBeenCalled()
  })

  it('wraps a chain-id read fault as a retryable unavailable denial', async () => {
    await expectUnavailable(
      readMakerPendingNonce(
        config,
        expected,
        transport({
          chainId: async () => {
            throw new Error('socket hang up')
          }
        })
      ),
      'chain-id'
    )
  })

  it('wraps a nonce read fault as a retryable unavailable denial', async () => {
    await expectUnavailable(
      readMakerPendingNonce(
        config,
        expected,
        transport({
          pendingNonce: async () => {
            throw new Error('socket hang up')
          }
        })
      ),
      'pending-nonce'
    )
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects the malformed provider nonce %s as unavailable',
    async nonce => {
      await expectUnavailable(
        readMakerPendingNonce(config, expected, transport({ pendingNonce: async () => nonce })),
        'pending-nonce'
      )
    }
  )

  it('keeps the endpoint url out of every error message', async () => {
    const failures = [
      readMakerPendingNonce(config, expected, transport({ chainId: async () => 1 })),
      readMakerPendingNonce(
        config,
        expected,
        transport({
          pendingNonce: async () => {
            throw new Error('boom')
          }
        })
      )
    ]
    for (const failure of failures) {
      await expect(failure).rejects.toSatisfy(
        error => !(error as Error).message.includes('rpc.example')
      )
    }
  })

  it('mentions rpc errors as instances of the typed rpc classes', async () => {
    await expect(
      readMakerPendingNonce(config, expected, transport({ chainId: async () => 1 }))
    ).rejects.toBeInstanceOf(RpcChainMismatchError)
    await expect(
      readMakerPendingNonce(
        config,
        expected,
        transport({
          pendingNonce: async () => {
            throw new Error('boom')
          }
        })
      )
    ).rejects.toBeInstanceOf(RpcUnavailableError)
  })
})
