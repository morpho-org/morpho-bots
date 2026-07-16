import type { SwapPlan, SwapStep } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { MorphoAbi } from '@repo/contracts'
import { ExecutorEncoder, executorAbi } from 'executooor-viem'
import { encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, isAddressEqual } from 'viem'

import type { MarketParams } from '../market'

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
 * encoder commit to a token amount it cannot know off-chain — a redeem/swap output and the approval
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
 * The USDT-safe allowance pair: (1) zero then (2) set `spender`'s allowance for `token` to the
 * Executor's live balance. The zero-first guards approve-from-nonzero-reverting (USDT-style) tokens
 * against a residual allowance any prior caller could have left on this shared singleton; the
 * balance-based set is harmless over-approval — a fixed-amount call pulls only its committed
 * amount, and the residual is swept.
 */
function approvePair(token: Address, spender: Address, executor: Address): Hex[] {
  return [
    ExecutorEncoder.buildCall(
      token,
      0n,
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 0n] })
    ),
    ExecutorEncoder.buildCall(
      token,
      0n,
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 0n] }),
      undefined,
      [balanceOfPlaceholder(token, executor, ERC20_AMOUNT_OFFSET)]
    )
  ]
}

/**
 * One plan step as Executor sub-calls: the USDT-safe approve pair when the step's target pulls
 * `tokenIn` (venue router/aggregator, Pendle router — a redeem burning the caller's own balance
 * needs none), then the step call itself. The step is venue-agnostic opaque calldata; the encoder
 * only decides how its input amount is bound. `'balance'` splices the Executor's live `tokenIn`
 * balance at the step-supplied offset; `'fixed'` calldata is route-bound to an amount committed
 * off-chain and must NOT be spliced — any drift between it and the Executor's actual balance fails
 * closed in `simulate()`.
 */
function stepCalls(step: SwapStep, executor: Address): Hex[] {
  return [
    ...(step.approvalSpender ? approvePair(step.tokenIn, step.approvalSpender, executor) : []),
    step.amountIn.source === 'balance'
      ? ExecutorEncoder.buildCall(step.target, step.value, step.callData, undefined, [
          balanceOfPlaceholder(step.tokenIn, executor, step.amountIn.offset)
        ])
      : ExecutorEncoder.buildCall(step.target, step.value, step.callData)
  ]
}

/**
 * The plan's intermediate tokens (each step's output that is neither of `exclude`), deduped —
 * every one needs its own sweep to uphold the full-drain invariant, because a fixed-amount step
 * sells its committed amount and leaves the worst-case-vs-actual surplus behind.
 */
function intermediateTokens(steps: readonly SwapStep[], exclude: readonly Address[]): Address[] {
  const seen = new Set<string>()
  const intermediates: Address[] = []
  for (const step of steps) {
    if (exclude.some(token => isAddressEqual(token, step.tokenOut))) continue
    const key = getAddress(step.tokenOut)
    if (seen.has(key)) continue
    seen.add(key)
    intermediates.push(step.tokenOut)
  }
  return intermediates
}

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
    // Trailing sweeps run after Blue pulls the repay token inside `liquidate`. Both market tokens
    // first (stable ordering for consumers), then any intermediates the step chain introduced.
    skimCall(loanToken, params.recipient, executor),
    skimCall(collateralToken, params.recipient, executor),
    ...intermediateTokens(plan.steps, [loanToken, collateralToken]).map(token =>
      skimCall(token, params.recipient, executor)
    )
  ]

  return encodeFunctionData({ abi: executorAbi, functionName: 'exec_606BaXt', args: [calls] })
}
