import type { Hex } from 'viem'

import { describe, expect, test, vi } from 'vitest'

import { StartupCleanupFailedError } from '../../../src/application/quoter-bot/startup-cleanup-failed.error'
import { cancelOwnedOffersOnStartupFailure } from '../../../src/application/quoter-bot/startup-cleanup.utils'
import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'
import { LadderHardHaltError } from '../../../src/infrastructure/ladder/ladder-hard-halt.error'

const groupId: Hex = `0x${'AB'.repeat(32)}`
const txHash: Hex = `0x${'cd'.repeat(32)}`
const succeeding = (result: unknown = { submittedTransactions: [] }) => {
  const cleanup = vi.fn(async () => result as { submittedTransactions: [] })
  return { cleanup, target: async () => ({ cleanup }) }
}
const failing = (error: unknown) => {
  const cleanup = vi.fn(async () => {
    throw error
  })
  return { cleanup, target: async () => ({ cleanup }) }
}

describe('cancelOwnedOffersOnStartupFailure', () => {
  test('returns the startup result without cleaning up', async () => {
    const ladder = succeeding()
    const bootstrap = succeeding()

    await expect(
      cancelOwnedOffersOnStartupFailure(
        {
          signal: new AbortController().signal,
          ladder: ladder.target,
          bootstrap: bootstrap.target
        },
        async () => 'started'
      )
    ).resolves.toBe('started')
    expect(ladder.cleanup).not.toHaveBeenCalled()
    expect(bootstrap.cleanup).not.toHaveBeenCalled()
  })

  test('cleans up when a non-abort failure races an operator abort', async () => {
    const controller = new AbortController()
    const ladder = succeeding()
    const bootstrap = succeeding()
    const failure = new LadderAdapterError('removed-market-cleanup')

    await expect(
      cancelOwnedOffersOnStartupFailure(
        { signal: controller.signal, ladder: ladder.target, bootstrap: bootstrap.target },
        async () => {
          controller.abort()
          throw failure
        }
      )
    ).rejects.toBe(failure)
    expect(ladder.cleanup).toHaveBeenCalledTimes(1)
    expect(bootstrap.cleanup).toHaveBeenCalledTimes(1)
  })

  test('projects only allowlisted names, bytes32 IDs, and confirmed transactions', async () => {
    const ladder = failing(
      new LadderHardHaltError([
        { groupId, errorName: 'https://rpc.example/secret' },
        { groupId: 'not-a-group' as Hex, errorName: 'LadderAdapterError' }
      ])
    )
    const bootstrap = succeeding({
      submittedTransactions: [
        { operation: 'cancel', txHash, extra: 'https://rpc.example' },
        { operation: 'drain', txHash },
        { operation: 'cancel', txHash: '0xshort' }
      ],
      url: 'https://rpc.example'
    })

    const error = await cancelOwnedOffersOnStartupFailure(
      { signal: new AbortController().signal, ladder: ladder.target, bootstrap: bootstrap.target },
      async () => {
        throw new Error('https://rpc.example/secret')
      }
    ).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(StartupCleanupFailedError)
    expect((error as StartupCleanupFailedError).report).toEqual({
      reason: 'startup-cleanup-failed',
      errorName: 'UnknownError',
      ladder: {
        status: 'failed',
        errorName: 'LadderHardHaltError',
        unresolvedGroupIds: [groupId.toLowerCase()]
      },
      bootstrap: { status: 'succeeded', transactions: [{ operation: 'cancel', txHash }] }
    })
    expect(JSON.stringify((error as StartupCleanupFailedError).report)).not.toContain('rpc.example')
  })

  test.each(['CustomProviderError', 'LadderHardHaltError'])(
    'takes unresolved group IDs only from a genuine hard-halt aggregate, not a %s lookalike',
    async name => {
      const hostile = failing(
        Object.assign(new Error('provider body'), { name, failures: [{ groupId }] })
      )

      const error = await cancelOwnedOffersOnStartupFailure(
        {
          signal: new AbortController().signal,
          ladder: hostile.target,
          bootstrap: succeeding().target
        },
        async () => {
          throw new LadderAdapterError('removed-market-cleanup')
        }
      ).catch((value: unknown) => value)

      expect((error as StartupCleanupFailedError).report.ladder).not.toHaveProperty(
        'unresolvedGroupIds'
      )
    }
  )

  test('reports an unenumerable ownership scope without inventing group IDs', async () => {
    const ladder = succeeding()
    const bootstrap = failing(new LadderAdapterError('group-ownership-state'))

    const error = await cancelOwnedOffersOnStartupFailure(
      { signal: new AbortController().signal, ladder: ladder.target, bootstrap: bootstrap.target },
      async () => {
        throw new LadderAdapterError('removed-market-cleanup')
      }
    ).catch((value: unknown) => value)

    expect((error as StartupCleanupFailedError).report).toMatchObject({
      errorName: 'LadderAdapterError',
      adapterOperation: 'removed-market-cleanup',
      bootstrap: {
        status: 'failed',
        errorName: 'LadderAdapterError',
        adapterOperation: 'group-ownership-state'
      }
    })
    expect((error as StartupCleanupFailedError).report.bootstrap).not.toHaveProperty(
      'unresolvedGroupIds'
    )
  })

  test('treats a failed cleanup-target composition as a failed cleanup', async () => {
    const ladder = succeeding()

    const error = await cancelOwnedOffersOnStartupFailure(
      {
        signal: new AbortController().signal,
        ladder: ladder.target,
        bootstrap: async () => {
          throw new LadderAdapterError('signer-identity-mismatch')
        }
      },
      async () => {
        throw new LadderAdapterError('removed-market-cleanup')
      }
    ).catch((value: unknown) => value)

    expect((error as StartupCleanupFailedError).report.bootstrap).toEqual({
      status: 'failed',
      errorName: 'LadderAdapterError',
      adapterOperation: 'signer-identity-mismatch'
    })
    expect(ladder.cleanup).toHaveBeenCalledTimes(1)
  })

  test.each([
    [
      'rejects',
      async () => {
        throw new Error('stdout closed')
      }
    ],
    [
      'throws synchronously',
      () => {
        throw new Error('stdout closed')
      }
    ]
  ])(
    'rethrows the startup failure when the cleanup record writer %s',
    async (_name, writeEvent) => {
      const failure = new LadderAdapterError('removed-market-cleanup')

      await expect(
        cancelOwnedOffersOnStartupFailure(
          {
            signal: new AbortController().signal,
            ladder: succeeding().target,
            bootstrap: succeeding().target,
            writeEvent
          },
          async () => {
            throw failure
          }
        )
      ).rejects.toBe(failure)
    }
  )
})
