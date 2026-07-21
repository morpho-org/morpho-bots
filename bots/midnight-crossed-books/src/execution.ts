import type { Hex } from 'viem'
import { CrossedBooksResolver } from '@repo/contracts'
import { encodeFunctionData } from 'viem'
import type { CrossedMatch } from './matching'
export function encodeResolve(match:CrossedMatch,minimumProfit:bigint):Hex{return encodeFunctionData({abi:CrossedBooksResolver.abi,functionName:'resolve',args:[match.ask.offer,match.ask.ratifierData,match.bid.offer,match.bid.ratifierData,match.units,minimumProfit]})}
