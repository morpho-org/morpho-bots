import { CrossedBooksResolver } from '@repo/contracts'
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult } from 'viem'

import { ViemResolverEncoder } from '../../../src/infrastructure/resolver/resolver.encoder'
import { makeOffer } from '../../fixtures/offers'

const ASK_0 = makeOffer('ask', 5n, 2n)
const ASK_1 = makeOffer('ask', 6n, 3n)
const BID = makeOffer('bid', 7n, 5n)
const MATCHES = [
  { ask: ASK_0, bid: BID, units: 2n },
  { ask: ASK_1, bid: BID, units: 3n }
]

const encoder = new ViemResolverEncoder()

describe('ViemResolverEncoder', () => {
  test('encodes all sell and buy offers and aggregates repeated offer fills', () => {
    const data = encoder.encode(MATCHES, 10n)
    const decoded = decodeFunctionData({ abi: CrossedBooksResolver.abi, data })

    expect(decoded.functionName).toBe('resolve')
    expect(decoded.args).toEqual([
      [
        { offer: ASK_0.offer, ratifierData: ASK_0.ratifierData, units: 2n },
        { offer: ASK_1.offer, ratifierData: ASK_1.ratifierData, units: 3n }
      ],
      [{ offer: BID.offer, ratifierData: BID.ratifierData, units: 5n }],
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
