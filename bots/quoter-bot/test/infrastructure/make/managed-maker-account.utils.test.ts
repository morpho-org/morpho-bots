import { createPublicClient, custom } from 'viem'
import { base } from 'viem/chains'
import { describe, expect, test } from 'vitest'

import { createManagedMakerAccount } from '../../../src/infrastructure/make/managed-maker-account.utils'

describe('createManagedMakerAccount', () => {
  test('allocates sequential nonces when pending RPC truth briefly remains stale', async () => {
    let nonceReads = 0
    const client = createPublicClient({
      chain: base,
      transport: custom({
        request: async ({ method }) => {
          if (method !== 'eth_getTransactionCount') throw new TypeError('unexpected RPC method')
          nonceReads += 1
          return '0x7'
        }
      })
    })
    const account = createManagedMakerAccount(`0x${'11'.repeat(32)}`)
    const nonceManager = account.nonceManager
    if (!nonceManager) throw new TypeError('managed account is missing its nonce manager')
    const parameters = {
      address: account.address,
      chainId: base.id,
      client
    }

    const first = await nonceManager.consume(parameters)
    const second = await nonceManager.consume(parameters)

    expect([first, second]).toEqual([7, 8])
    expect(nonceReads).toBe(2)
  })
})
