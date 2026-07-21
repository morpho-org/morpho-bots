import { describe, expect, mock, test } from 'bun:test'

import type { PreparedResolution } from '../../../src/domain/order-book'
import type { ResolverTransport } from '../../../src/infrastructure/resolver/resolver.transport'

import { ResolverExecutionService } from '../../../src/infrastructure/resolver/resolver.service'
import { MARKET_ID, makeOffer } from '../../fixtures/offers'

const MATCH = {
  ask: makeOffer('ask', 5n, 2n),
  bid: makeOffer('bid', 7n, 2n),
  units: 2n
}

function setup(result: Awaited<ReturnType<ResolverTransport['simulate']>>) {
  const simulate = mock(async () => result)
  const submit = mock(async () => undefined)
  const transport: ResolverTransport = { simulate, submit }
  const encoder = {
    encode: mock(() => '0x1234' as const),
    decodeProfit: mock(() => 42n)
  }
  const service = new ResolverExecutionService(transport, encoder, 10n)

  return { service, encoder, simulate, submit }
}

describe('ResolverExecutionService', () => {
  test('encodes and simulates with the configured minimum profit', async () => {
    const { service, encoder, simulate } = setup({ status: 'success', data: '0xabcd' })

    await service.simulate(MATCH)

    expect(encoder.encode).toHaveBeenCalledWith(MATCH, 10n)
    expect(simulate).toHaveBeenCalledWith('0x1234')
  })

  test('returns a prepared immutable request after successful simulation', async () => {
    const { service } = setup({ status: 'success', data: '0xabcd' })

    const result = await service.simulate(MATCH)

    expect(result).toEqual({
      status: 'ok',
      prepared: { marketId: MARKET_ID, data: '0x1234', profit: 42n }
    })
  })

  test('does not decode a reverted simulation', async () => {
    const { service, encoder } = setup({ status: 'revert', reason: 'InsufficientProfit' })

    const result = await service.simulate(MATCH)

    expect(result).toEqual({ status: 'revert', reason: 'InsufficientProfit' })
    expect(encoder.decodeProfit).not.toHaveBeenCalled()
  })

  test('submits the exact calldata prepared by simulation', async () => {
    const { service, submit } = setup({ status: 'success', data: '0xabcd' })
    const prepared: PreparedResolution = {
      marketId: MARKET_ID,
      data: '0x1234',
      profit: 42n
    }

    await service.submit(prepared, 99n)

    expect(submit).toHaveBeenCalledWith(prepared, 99n)
  })
})
