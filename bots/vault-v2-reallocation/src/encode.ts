import type { InputMarketParams } from '@morpho-org/blue-sdk'
import type { Address, Hex } from 'viem'

import { marketParamsAbi } from '@morpho-org/blue-sdk'
import { vaultV2Abi } from '@morpho-org/blue-sdk-viem'
import { encodeAbiParameters, encodeFunctionData } from 'viem'

import type { Reallocation } from './strategies'

const encodeMarketParams = (params: InputMarketParams): Hex =>
  encodeAbiParameters([marketParamsAbi], [params])

/**
 * Encodes one vault's planned move as a single `VaultV2.multicall(bytes[])` — deallocate legs
 * strictly first so the idle balance is funded before allocations draw on it. Each leg is
 * `allocate/deallocate(adapter, abi.encode(marketParams), assets)`. These are the exact bytes the
 * tick simulates and the queue broadcasts.
 */
export const encodeReallocation = (adapter: Address, reallocation: Reallocation): Hex =>
  encodeFunctionData({
    abi: vaultV2Abi,
    functionName: 'multicall',
    args: [
      [
        ...reallocation.deallocations.map(leg =>
          encodeFunctionData({
            abi: vaultV2Abi,
            functionName: 'deallocate',
            args: [adapter, encodeMarketParams(leg.marketParams), leg.assets]
          })
        ),
        ...reallocation.allocations.map(leg =>
          encodeFunctionData({
            abi: vaultV2Abi,
            functionName: 'allocate',
            args: [adapter, encodeMarketParams(leg.marketParams), leg.assets]
          })
        )
      ]
    ]
  })
