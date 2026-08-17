import { marketParamsAbi } from '@morpho-org/blue-sdk'
import { vaultV2Abi } from '@morpho-org/blue-sdk-viem'
import { decodeAbiParameters, decodeFunctionData, getAddress, parseUnits } from 'viem'
import { beforeEach, describe, expect, it } from 'vitest'

import { encodeReallocation } from '../src/encode'
import { ADAPTER, makeMarketParams, resetMarketCounter } from './strategies/helpers'

describe('encodeReallocation', () => {
  beforeEach(() => {
    resetMarketCounter()
  })

  it('encodes deallocate legs strictly before allocate legs with exact args', () => {
    const hotParams = makeMarketParams()
    const coldParams = makeMarketParams()
    const data = encodeReallocation(ADAPTER, {
      allocations: [{ marketParams: hotParams, assets: parseUnits('123', 6) }],
      deallocations: [{ marketParams: coldParams, assets: parseUnits('456', 6) }]
    })

    const outer = decodeFunctionData({ abi: vaultV2Abi, data })
    if (outer.functionName !== 'multicall') throw new Error('expected multicall')
    const calls = outer.args[0]
    expect(calls.length).toBe(2)

    const first = decodeFunctionData({ abi: vaultV2Abi, data: calls[0]! })
    const second = decodeFunctionData({ abi: vaultV2Abi, data: calls[1]! })
    if (first.functionName !== 'deallocate') throw new Error('expected deallocate first')
    if (second.functionName !== 'allocate') throw new Error('expected allocate second')

    // Each leg: (adapter, abi.encode(marketParams), assets).
    expect(getAddress(first.args[0])).toBe(ADAPTER)
    expect(first.args[2]).toBe(parseUnits('456', 6))
    const [decodedCold] = decodeAbiParameters([marketParamsAbi], first.args[1])
    expect(decodedCold).toEqual(coldParams)

    expect(getAddress(second.args[0])).toBe(ADAPTER)
    expect(second.args[2]).toBe(parseUnits('123', 6))
    const [decodedHot] = decodeAbiParameters([marketParamsAbi], second.args[1])
    expect(decodedHot).toEqual(hotParams)
  })

  it('encodes a deallocate-only plan (surplus parks in idle)', () => {
    const params = makeMarketParams()
    const data = encodeReallocation(ADAPTER, {
      allocations: [],
      deallocations: [{ marketParams: params, assets: 1n }]
    })
    const outer = decodeFunctionData({ abi: vaultV2Abi, data })
    if (outer.functionName !== 'multicall') throw new Error('expected multicall')
    expect(outer.args[0].length).toBe(1)
    expect(decodeFunctionData({ abi: vaultV2Abi, data: outer.args[0][0]! }).functionName).toBe(
      'deallocate'
    )
  })
})
