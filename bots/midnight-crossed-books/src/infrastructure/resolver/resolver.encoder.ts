import type { Hex } from 'viem'

import { CrossedBooksResolver } from '@repo/contracts'
import { decodeFunctionResult, encodeFunctionData } from 'viem'

import type { CrossedMatch } from '../../domain/order-book'

export interface ResolverEncoder {
  encode(match: CrossedMatch, minimumProfit: bigint): Hex
  decodeProfit(data: Hex): bigint
}

export class ViemResolverEncoder implements ResolverEncoder {
  encode(match: CrossedMatch, minimumProfit: bigint) {
    return encodeFunctionData({
      abi: CrossedBooksResolver.abi,
      functionName: 'resolve',
      args: [
        match.ask.offer,
        match.ask.ratifierData,
        match.bid.offer,
        match.bid.ratifierData,
        match.units,
        minimumProfit
      ]
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
