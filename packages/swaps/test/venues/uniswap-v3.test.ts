import { decodeFunctionData, getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { QuoteParameters } from '../../src/types'

import { quoteUniswapV3, SWAP_AMOUNT_IN_OFFSET } from '../../src/venues/uniswap-v3'

const ROUTER = getAddress('0x5555555555555555555555555555555555555555')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')

// Local copy of the SwapRouter02 `exactInputSingle` shape, for decoding the built calldata.
const EXACT_INPUT_SINGLE_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' }
        ]
      }
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }]
  }
] as const

function params(overrides: Partial<QuoteParameters> = {}): QuoteParameters {
  return {
    chainId: 8453,
    tokenIn: COLLATERAL,
    tokenOut: LOAN,
    amountIn: 1000n,
    slippageBps: 50,
    executor: EXECUTOR,
    referenceAmountOut: 2000n,
    minAcceptableAmountOut: 0n,
    ...overrides
  }
}

describe('quoteUniswapV3', () => {
  it('builds a balance-bound Swap with the router as target + spender', () => {
    const swap = quoteUniswapV3({ router: ROUTER, fee: 3000 }, params())
    expect(swap.spender).toBe(ROUTER)
    expect(swap.target).toBe(ROUTER)
    expect(swap.value).toBe(0n)
    expect(swap.amountIn).toEqual({ source: 'balance', offset: SWAP_AMOUNT_IN_OFFSET })
    expect(swap.expectedAmountOut).toBe(2000n)
    // 2000 × (10000 - 50) / 10000 = 1990.
    expect(swap.amountOutMinimum).toBe(1990n)
  })

  it('encodes exactInputSingle with amountIn=0 (spliced at exec) and the slippage-bounded min', () => {
    const swap = quoteUniswapV3({ router: ROUTER, fee: 3000 }, params())
    const decoded = decodeFunctionData({ abi: EXACT_INPUT_SINGLE_ABI, data: swap.callData })
    if (decoded.functionName !== 'exactInputSingle') throw new Error('expected exactInputSingle')
    expect(decoded.args[0].tokenIn).toBe(COLLATERAL)
    expect(decoded.args[0].tokenOut).toBe(LOAN)
    expect(decoded.args[0].fee).toBe(3000)
    expect(decoded.args[0].recipient).toBe(EXECUTOR)
    expect(decoded.args[0].amountIn).toBe(0n)
    expect(decoded.args[0].amountOutMinimum).toBe(1990n)
  })

  it('applies no reduction when slippageBps is 0', () => {
    const swap = quoteUniswapV3({ router: ROUTER, fee: 3000 }, params({ slippageBps: 0 }))
    expect(swap.amountOutMinimum).toBe(2000n)
  })
})
