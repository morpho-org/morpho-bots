import type { Address, Hex } from 'viem'

import { MorphoAbi } from '@repo/contracts'
import { ExecutorEncoder, executorAbi } from 'executooor-viem'
import { encodeAbiParameters, encodeFunctionData, erc20Abi } from 'viem'

import type { MarketParams } from '../market'
import type { Swap } from '../quotes/types'

// `approve(spender, amount)` / `transfer(recipient, amount)`: the amount word sits at byte offset
// 4 (selector) + 32 (the address word).
const ERC20_AMOUNT_OFFSET = 36n

// onMorphoLiquidate(uint256 repaidAssets, bytes data) — `data` is the 2nd arg, so its head word (the
// offset pointer the Executor's fallback reads the queue from) is at index 1. This mirrors
// executooor-viem's `morphoBlueLiquidate` (verified against executooor-viem@1.3.3).
const CALLBACK_DATA_INDEX = 1n

/**
 * A self-referential placeholder: at exec time the Executor staticcalls `asset.balanceOf(executor)`
 * and splices the result over the `amountOffset` word of the sub-call's calldata. This lets the
 * encoder commit to a token amount it cannot know off-chain — the swap output and the approval
 * amounts are computed against the Executor's *live* balance.
 */
function balanceOfPlaceholder(asset: Address, executor: Address, amountOffset: bigint) {
  return {
    to: asset,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [executor] }),
    offset: amountOffset,
    length: 32n,
    resOffset: 0n
  }
}

/**
 * Drains the Executor's entire balance of `asset` to `recipient` via `transfer(recipient,
 * balanceOf(executor))`, with the amount filled in at exec time by a balanceOf placeholder so the
 * encoder needs no balance prediction.
 */
function skimCall(asset: Address, recipient: Address, executor: Address): Hex {
  return ExecutorEncoder.buildCall(
    asset,
    0n,
    encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, 0n] }),
    undefined,
    [balanceOfPlaceholder(asset, executor, ERC20_AMOUNT_OFFSET)]
  )
}

/**
 * Encodes the `Executor.exec_606BaXt(bytes[])` calldata for one Morpho Blue liquidation against the
 * **generic** (handler-less) Executor singleton. `Morpho.liquidate(marketParams, borrower,
 * seizedAssets, /*repaidShares*\/ 0, data)` runs with `msg.sender = the Executor`, so Blue transfers
 * the seized collateral to the Executor, then calls `Executor.onMorphoLiquidate(repaidAssets, data)`,
 * then pulls `repaidAssets` of the loan token via `safeTransferFrom` after.
 *
 * The swap and repay approval ride inside `data` as the Executor callback queue: a
 * `(bytes[] queue, bytes returnData)` blob its `fallback` decodes and runs. Blue ignores the callback
 * return, so `returnData` is empty `0x`. Two trailing sweeps drain both tokens to the EOA.
 *
 * Every plan is seize-exact with `seizedAssets > 0` (Blue forbids a `(0,0)` liquidate; the degenerate
 * collateral-less residual is skipped upstream in `plan()`), so a swap is always required.
 */
export function encodeLiquidationExec(params: {
  executor: Address
  morpho: Address
  market: MarketParams
  seizedAssets: bigint
  borrower: Address
  swap: Swap
  recipient: Address
}): Hex {
  const { executor, morpho, market, swap } = params
  const collateralToken = market.collateralToken
  const loanToken = market.loanToken

  // The swap call is venue-agnostic opaque calldata produced by the venue adapter; the encoder only
  // decides how its input amount is bound. `'balance'` (Uniswap exactInputSingle) splices the
  // Executor's live collateral balance at the venue-supplied offset. `'fixed'` (aggregator) calldata
  // is route-bound to a sell amount committed off-chain and must NOT be spliced; any drift between
  // that and the Executor's actual balance fails closed in `simulate()`.
  const swapCall =
    swap.amountIn.source === 'balance'
      ? ExecutorEncoder.buildCall(swap.target, swap.value, swap.callData, undefined, [
          balanceOfPlaceholder(collateralToken, executor, swap.amountIn.offset)
        ])
      : ExecutorEncoder.buildCall(swap.target, swap.value, swap.callData)

  // The callback queue the Executor runs when Blue calls back into `onMorphoLiquidate`. The seized
  // collateral is already on the Executor; this swaps it to the loan token and approves Blue to pull
  // the repay. The two approval amounts come from the Executor's live `balanceOf` because the seized
  // collateral (aggregator branch) and the recomputed `repaidAssets` are known only on-chain.
  const callbackQueue: Hex[] = [
    // (1) zero then (2) set the swap spender's allowance for the seized collateral. The pair guards
    //     approve-from-nonzero-reverting (USDT-style) tokens against a residual allowance any prior
    //     caller could have left on this shared singleton. Over-approving the live balance is
    //     harmless — an aggregator pulls only its fixed sell amount, and the residual is swept.
    ExecutorEncoder.buildCall(
      collateralToken,
      0n,
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [swap.spender, 0n] })
    ),
    ExecutorEncoder.buildCall(
      collateralToken,
      0n,
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [swap.spender, 0n] }),
      undefined,
      [balanceOfPlaceholder(collateralToken, executor, ERC20_AMOUNT_OFFSET)]
    ),
    // (3) swap seized collateral → loan token, output back to the Executor.
    swapCall,
    // (4) zero then (5) set Blue's repay allowance. Balance-based because `repaidAssets` is
    //     recomputed on-chain. Zero-first handles approve-from-nonzero tokens.
    ExecutorEncoder.buildCall(
      loanToken,
      0n,
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [morpho, 0n] })
    ),
    ExecutorEncoder.buildCall(
      loanToken,
      0n,
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [morpho, 0n] }),
      undefined,
      [balanceOfPlaceholder(loanToken, executor, ERC20_AMOUNT_OFFSET)]
    )
  ]

  // Blue ignores `onMorphoLiquidate`'s return value, so callback return data is empty.
  const callbackData = encodeAbiParameters(
    [{ type: 'bytes[]' }, { type: 'bytes' }],
    [callbackQueue, '0x']
  )

  const liquidateData = encodeFunctionData({
    abi: MorphoAbi,
    functionName: 'liquidate',
    args: [market, params.borrower, params.seizedAssets, 0n, callbackData]
  })

  const calls: Hex[] = [
    // The liquidate call carries the callback context so the Executor's `fallback` authorizes
    // `msg.sender == MORPHO` and reads the queue from `data`, whose head word (offset pointer) is at
    // index 1 in `onMorphoLiquidate(uint256 repaidAssets, bytes data)`.
    ExecutorEncoder.buildCall(morpho, 0n, liquidateData, {
      sender: morpho,
      dataIndex: CALLBACK_DATA_INDEX
    }),
    // Trailing sweeps run after Blue pulls the repay token inside `liquidate`.
    skimCall(loanToken, params.recipient, executor),
    skimCall(collateralToken, params.recipient, executor)
  ]

  return encodeFunctionData({ abi: executorAbi, functionName: 'exec_606BaXt', args: [calls] })
}
