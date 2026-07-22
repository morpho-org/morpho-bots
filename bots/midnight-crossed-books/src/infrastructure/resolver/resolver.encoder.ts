import type { Hex } from 'viem'

import { CrossedBooksResolver } from '@repo/contracts'
import { decodeFunctionResult, encodeFunctionData } from 'viem'

import type { CrossedMatch, TakeableOffer } from '../../domain/order-book'

export interface ResolverEncoder {
  encode(matches: readonly CrossedMatch[], minimumProfit: bigint): Hex
  decodeProfit(data: Hex): bigint
}

function takeKey(takeable: TakeableOffer) {
  return encodeFunctionData({
    abi: CrossedBooksResolver.abi,
    functionName: 'resolve',
    args: [[{ offer: takeable.offer, ratifierData: takeable.ratifierData, units: 0n }], [], 0n]
  })
}

function aggregate(matches: readonly CrossedMatch[], side: 'ask' | 'bid') {
  const takesByKey = new Map<Hex, { takeable: TakeableOffer; units: bigint }>()

  for (const match of matches) {
    const takeable = match[side]
    const key = takeKey(takeable)
    const existing = takesByKey.get(key)
    takesByKey.set(key, {
      takeable,
      units: (existing?.units ?? 0n) + match.units
    })
  }

  return Array.from(takesByKey.values(), ({ takeable, units }) => ({
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
