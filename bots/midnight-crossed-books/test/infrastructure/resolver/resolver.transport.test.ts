import { createPublicClient, custom } from 'viem'
import { base } from 'viem/chains'
import { describe, expect, test, vi } from 'vitest'

import { ReadonlyMutationError } from '../../../src/infrastructure/resolver/readonly-mutation.error'
import { ViemResolverTransport } from '../../../src/infrastructure/resolver/resolver.transport'
import { MARKET_ID } from '../../fixtures/offers'

const ADDRESS = `0x${'11'.repeat(20)}` as const
const CALLER = `0x${'22'.repeat(20)}` as const

const client = createPublicClient({
  chain: base,
  transport: custom({
    request: async () => {
      throw new Error('unexpected RPC request')
    }
  })
})

describe('ViemResolverTransport', () => {
  test('simulates the exact calldata from the configured execution-equivalent caller', async () => {
    const request = vi.fn(async () => '0xabcd' as const)
    const simulationClient = createPublicClient({ chain: base, transport: custom({ request }) })
    const transport = new ViemResolverTransport(simulationClient, CALLER, ADDRESS)

    await expect(transport.simulate('0x1234')).resolves.toEqual({
      status: 'success',
      data: '0xabcd'
    })
    expect(request).toHaveBeenCalledWith({
      method: 'eth_call',
      params: [
        {
          data: '0x1234',
          from: CALLER,
          to: ADDRESS,
          value: '0x0'
        },
        'latest'
      ]
    })
  })

  test('fails closed when readonly composition attempts to submit', async () => {
    const transport = new ViemResolverTransport(client, ADDRESS, ADDRESS)

    await expect(
      transport.submit({ marketId: MARKET_ID, data: '0x1234', profit: 42n }, 10n)
    ).rejects.toBeInstanceOf(ReadonlyMutationError)
  })
})
