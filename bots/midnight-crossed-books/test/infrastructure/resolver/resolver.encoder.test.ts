import { describe, expect, test } from 'bun:test'

import { CrossedBooksResolver } from '@repo/contracts'
import { decodeFunctionData, encodeFunctionResult } from 'viem'

import { ViemResolverEncoder } from '../../../src/infrastructure/resolver/resolver.encoder'
import { makeOffer } from '../../fixtures/offers'

const MATCH = {
  ask: makeOffer('ask', 5n, 2n),
  bid: makeOffer('bid', 7n, 2n),
  units: 2n
}

const encoder = new ViemResolverEncoder()

describe('ViemResolverEncoder', () => {
  test('encodes the exact ask, bid, units, and minimum profit', () => {
    const data = encoder.encode(MATCH, 10n)
    const decoded = decodeFunctionData({ abi: CrossedBooksResolver.abi, data })

    expect(decoded.functionName).toBe('resolve')
    expect(decoded.args).toEqual([
      MATCH.ask.offer,
      MATCH.ask.ratifierData,
      MATCH.bid.offer,
      MATCH.bid.ratifierData,
      2n,
      10n
    ])
  })

  test('decodes the resolver profit result', () => {
    const data = encodeFunctionResult({
      abi: CrossedBooksResolver.abi,
      functionName: 'resolve',
      result: 42n
    })

    expect(encoder.decodeProfit(data)).toBe(42n)
  })
})
