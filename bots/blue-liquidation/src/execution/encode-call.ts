import type { SwapPlan } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { MorphoAbi } from '@repo/contracts'
import { approvePair, stepCalls, sweepCalls } from '@repo/swaps'
import { ExecutorEncoder, executorAbi } from 'executooor-viem'
import { encodeAbiParameters, encodeFunctionData } from 'viem'

import type { MarketParams } from '../market'

// onMorphoLiquidate(uint256 repaidAssets, bytes data) — `data` is the 2nd arg, so its head word (the
// offset pointer the Executor's fallback reads the queue from) is at index 1. This mirrors
// executooor-viem's `morphoBlueLiquidate` (verified against executooor-viem@1.3.3).
const CALLBACK_DATA_INDEX = 1n

/**
 * Encodes the `Executor.exec_606BaXt(bytes[])` calldata for one Morpho Blue liquidation against the
 * **generic** (handler-less) Executor singleton. `Morpho.liquidate(marketParams, borrower,
 * seizedAssets, /*repaidShares*\/ 0, data)` runs with `msg.sender = the Executor`, so Blue transfers
 * the seized collateral to the Executor, then calls `Executor.onMorphoLiquidate(repaidAssets, data)`,
 * then pulls `repaidAssets` of the loan token via `safeTransferFrom` after.
 *
 * The sell path and repay approval ride inside `data` as the Executor callback queue: a
 * `(bytes[] queue, bytes returnData)` blob its `fallback` decodes and runs. The plan's steps chain
 * the seized collateral to the loan token — a plain collateral is one venue swap; exotic collateral
 * is unwrap step(s) (ERC4626 redeem etc.) then usually a venue swap, or none when the unwrap chain
 * already ends in the loan token. Blue ignores the callback return, so `returnData` is empty `0x`.
 * Trailing sweeps drain both market tokens plus every intermediate to the EOA.
 *
 * Every plan is seize-exact with `seizedAssets > 0` (Blue forbids a `(0,0)` liquidate; the degenerate
 * collateral-less residual is skipped upstream in `plan()`), so a swap plan is always required.
 */
export function encodeLiquidationExec(params: {
  executor: Address
  morpho: Address
  market: MarketParams
  seizedAssets: bigint
  borrower: Address
  plan: SwapPlan
  recipient: Address
}): Hex {
  const { executor, morpho, market, plan } = params
  const collateralToken = market.collateralToken
  const loanToken = market.loanToken

  // The callback queue the Executor runs when Blue calls back into `onMorphoLiquidate`. The seized
  // collateral is already on the Executor; the steps convert it to the loan token, then the repay
  // allowance pair approves Blue to pull `repaidAssets` — balance-based because that amount is
  // recomputed on-chain.
  const callbackQueue: Hex[] = [
    ...plan.steps.flatMap(step => stepCalls(step, executor)),
    ...approvePair(loanToken, morpho, executor)
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
    // Trailing sweeps run after Blue pulls the repay token inside `liquidate` — see
    // {@link sweepCalls} for the ordering and the same-token dedupe.
    ...sweepCalls({
      loanToken,
      collateralToken,
      steps: plan.steps,
      recipient: params.recipient,
      executor
    })
  ]

  return encodeFunctionData({ abi: executorAbi, functionName: 'exec_606BaXt', args: [calls] })
}
