import { describe, expect, it, vi } from 'vitest'

import type { ChainReadTransport } from '../src/chain-read.utils'
import type { RpcReadOperation } from '../src/rpc-unavailable.error'

import {
  readMakerAllowance,
  readMakerCode,
  readMakerNonceWindow,
  readMakerPendingNonce
} from '../src/chain-read.utils'
import { RpcChainMismatchError } from '../src/rpc-chain-mismatch.error'
import { RpcUnavailableError } from '../src/rpc-unavailable.error'
import { FIXTURE_LOAN_TOKEN, FIXTURE_MAKER, fixtureRemediationAction } from './policy-fixture'

const config = { url: 'https://rpc.example' }
const expected = { chainId: 8453, maker: FIXTURE_MAKER } as const
const allowanceQuery = {
  chainId: 8453,
  token: FIXTURE_LOAN_TOKEN,
  owner: FIXTURE_MAKER,
  spender: fixtureRemediationAction.spender
} as const

const transport = (overrides: Partial<ChainReadTransport> = {}): ChainReadTransport => ({
  chainId: async () => 8453,
  pendingNonce: async () => 7,
  latestNonce: async () => 5,
  allowance: async () => 0n,
  code: async () => '0x',
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

describe('readMakerNonceWindow', () => {
  it('returns the latest and pending counts after verifying the chain id', async () => {
    await expect(readMakerNonceWindow(config, expected, transport())).resolves.toStrictEqual({
      latest: 5,
      pending: 7
    })
  })

  it('accepts an empty window where nothing is in flight', async () => {
    await expect(
      readMakerNonceWindow(config, expected, transport({ pendingNonce: async () => 5 }))
    ).resolves.toStrictEqual({ latest: 5, pending: 5 })
  })

  it('fails closed terminally when the endpoint serves another chain, reading no counts', async () => {
    const latestNonce = vi.fn(async () => 5)

    await expect(
      readMakerNonceWindow(config, expected, transport({ chainId: async () => 1, latestNonce }))
    ).rejects.toBeInstanceOf(RpcChainMismatchError)
    expect(latestNonce).not.toHaveBeenCalled()
  })

  it('wraps a latest-nonce read fault as a retryable unavailable denial', async () => {
    await expectUnavailable(
      readMakerNonceWindow(
        config,
        expected,
        transport({
          latestNonce: async () => {
            throw new Error('socket hang up')
          }
        })
      ),
      'latest-nonce'
    )
  })

  it('reads pending before latest so the window is a conservative intersection', async () => {
    const order: string[] = []
    const pendingNonce = vi.fn(async () => {
      order.push('pending')
      return 7
    })
    const latestNonce = vi.fn(async () => {
      order.push('latest')
      return 5
    })

    await readMakerNonceWindow(config, expected, transport({ pendingNonce, latestNonce }))

    expect(order).toStrictEqual(['pending', 'latest'])
  })

  it('refuses a window that moved between the reads (latest above pending)', async () => {
    await expectUnavailable(
      readMakerNonceWindow(config, expected, transport({ pendingNonce: async () => 4 })),
      'latest-nonce'
    )
  })

  it.each([-1, 2.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects the malformed latest count %s as unavailable',
    async latest => {
      await expectUnavailable(
        readMakerNonceWindow(config, expected, transport({ latestNonce: async () => latest })),
        'latest-nonce'
      )
    }
  )
})

describe('readMakerAllowance', () => {
  it('returns the allowance for the exact pinned triple after verifying the chain id', async () => {
    const allowance = vi.fn(async () => 123n)

    await expect(
      readMakerAllowance(config, allowanceQuery, transport({ allowance }))
    ).resolves.toBe(123n)
    expect(allowance).toHaveBeenCalledExactlyOnceWith(config, {
      token: FIXTURE_LOAN_TOKEN,
      owner: FIXTURE_MAKER,
      spender: fixtureRemediationAction.spender
    })
  })

  it('fails closed terminally when the endpoint serves another chain, reading no allowance', async () => {
    const allowance = vi.fn(async () => 0n)

    await expect(
      readMakerAllowance(config, allowanceQuery, transport({ chainId: async () => 1, allowance }))
    ).rejects.toBeInstanceOf(RpcChainMismatchError)
    expect(allowance).not.toHaveBeenCalled()
  })

  it('wraps an allowance read fault as a retryable unavailable denial', async () => {
    await expectUnavailable(
      readMakerAllowance(
        config,
        allowanceQuery,
        transport({
          allowance: async () => {
            throw new Error('execution reverted')
          }
        })
      ),
      'allowance'
    )
  })

  it('rejects a malformed provider allowance as unavailable', async () => {
    await expectUnavailable(
      readMakerAllowance(
        config,
        allowanceQuery,
        transport({ allowance: async () => 5 as unknown as bigint })
      ),
      'allowance'
    )
  })
})

describe('readMakerCode', () => {
  it('returns the maker code after verifying the chain id', async () => {
    const code = vi.fn(async () => `0xef0100${'11'.repeat(20)}` as const)

    await expect(readMakerCode(config, expected, transport({ code }))).resolves.toBe(
      `0xef0100${'11'.repeat(20)}`
    )
    expect(code).toHaveBeenCalledExactlyOnceWith(config, FIXTURE_MAKER)
  })

  it('fails closed terminally when the endpoint serves another chain, reading no code', async () => {
    const code = vi.fn(async () => '0x' as const)

    await expect(
      readMakerCode(config, expected, transport({ chainId: async () => 1, code }))
    ).rejects.toBeInstanceOf(RpcChainMismatchError)
    expect(code).not.toHaveBeenCalled()
  })

  it('wraps a code read fault as a retryable unavailable denial', async () => {
    await expectUnavailable(
      readMakerCode(
        config,
        expected,
        transport({
          code: async () => {
            throw new Error('socket hang up')
          }
        })
      ),
      'maker-code'
    )
  })

  it('rejects a malformed provider code response as unavailable', async () => {
    await expectUnavailable(
      readMakerCode(
        config,
        expected,
        transport({ code: async () => undefined as unknown as `0x${string}` })
      ),
      'maker-code'
    )
  })
})
