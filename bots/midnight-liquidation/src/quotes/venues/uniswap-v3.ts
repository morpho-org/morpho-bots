import type { Address } from 'viem'

import { encodeFunctionData } from 'viem'

import type { QuoteParameters, Swap } from '../types'

import { BPS } from '../../constants'

/** The Uniswap-V3 arm of the per-collateral swap config. */
type UniswapV3Entry = { router: Address; fee: number }

// Uniswap `SwapRouter02` (`IV3SwapRouter`) `exactInputSingle`. NOTE: SwapRouter02 dropped the
// `deadline` field present in the original `SwapRouter`. Every field is static, so the params tuple
// is encoded inline (no offset pointer) and `amountIn` lands at calldata byte offset 4 + 4*32 = 132.
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

/** Byte offset of `amountIn` (field index 4) within the inline `exactInputSingle` params tuple. */
export const SWAP_AMOUNT_IN_OFFSET = 132n

/**
 * Builds the Uniswap-V3 single-hop {@link Swap} locally — no API, no key. `amountIn` is left at `0n`
 * and bound to the Executor's live collateral balance at exec time (`source: 'balance'`), so this
 * tolerates the cap-binding branch's on-chain seize derivation. The `amountOutMinimum` is the
 * operator's slippage tolerance applied to the lens's fresh oracle price; it fails closed — if the
 * pool can't fill it the swap reverts mid-`liquidate` and the whole tx rolls back (a missed
 * liquidation, never a loss).
 */
export function quoteUniswapV3(entry: UniswapV3Entry, params: QuoteParameters): Swap {
  const amountOutMinimum = (params.referenceAmountOut * (BPS - BigInt(params.slippageBps))) / BPS
  const callData = encodeFunctionData({
    abi: EXACT_INPUT_SINGLE_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee: entry.fee,
        recipient: params.executor,
        amountIn: 0n, // overwritten with the Executor's live collateral balance by the placeholder
        amountOutMinimum,
        sqrtPriceLimitX96: 0n
      }
    ]
  })
  return {
    spender: entry.router,
    target: entry.router,
    value: 0n,
    callData,
    amountIn: { source: 'balance', offset: SWAP_AMOUNT_IN_OFFSET },
    expectedAmountOut: params.referenceAmountOut,
    amountOutMinimum
  }
}
