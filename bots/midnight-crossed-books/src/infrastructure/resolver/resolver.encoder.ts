import type { Hex } from 'viem'

import { CrossedBooksResolver } from '@repo/contracts'
import { decodeFunctionResult, encodeFunctionData } from 'viem'

import type { CrossedMatch, TakeableOffer } from '../../domain/order-book'

export interface ResolverEncoder {
  encode(matches: readonly CrossedMatch[], minimumProfit: bigint): Hex
  decodeProfit(data: Hex): bigint
}

function aggregate(matches: readonly CrossedMatch[], side: 'ask' | 'bid') {
  const unitsByOffer = new Map<TakeableOffer, bigint>()

  for (const match of matches) {
    const offer = match[side]
    unitsByOffer.set(offer, (unitsByOffer.get(offer) ?? 0n) + match.units)
  }

  return Array.from(unitsByOffer, ([takeable, units]) => ({
    offer: takeable.offer,
    ratifierData: takeable.ratifierData,
    units
  }))
}

export class ViemResolverEncoder implements ResolverEncoder {
  encode(matches: readonly CrossedMatch[], minimumProfit: bigint) {
    return encodeFunctionData({
      abi: CrossedBooksResolver.abi,
      functionName: 'resolve',
      args: [aggregate(matches, 'ask'), aggregate(matches, 'bid'), minimumProfit]
    })
  }

  decodeProfit(data: Hex): bigint {
    const profit = decodeFunctionResult({
      abi: CrossedBooksResolver.abi,
      functionName: 'resolve',
      data
    })
    if (typeof profit !== 'bigint') throw new Error('Invalid resolver profit result')
    return profit
  }
}
