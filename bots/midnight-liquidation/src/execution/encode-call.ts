import type { SwapPlan, SwapStep } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { MidnightAbi } from '@repo/contracts'
import { ExecutorEncoder, executorAbi } from 'executooor-viem'
import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddressEqual,
  zeroAddress
} from 'viem'

import { CALLBACK_SUCCESS } from '../constants'
import { isBadDebtRealization } from '../sizing/plan'

// The Midnight `Market` struct passed to `liquidate`. The bot reads it on-chain from the lens
// (`toMarket(id)`) and re-passes it verbatim.
export type CollateralParams = {
  token: Address
  lltv: bigint
  liquidationCursor: bigint
  oracle: Address
}
export type Market = {
  chainId: bigint
  midnight: Address
  loanToken: Address
  collateralParams: readonly CollateralParams[]
  maturity: bigint
  rcfThreshold: bigint
  enterGate: Address
  liquidatorGate: Address
}

// `approve(spender, amount)` / `transfer(recipient, amount)`: the amount word sits at byte offset
// 4 (selector) + 32 (the address word).
const ERC20_AMOUNT_OFFSET = 36n

/**
 * A self-referential placeholder: at exec time the Executor staticcalls `asset.balanceOf(executor)`
 * and splices the result over the `amountOffset` word of the sub-call's calldata. This lets the
 * encoder commit to a token amount it cannot know off-chain — the seized collateral (the cap-binding
 * branch passes `seizedAssets = 0` and the contract derives the amount) and a redeem/swap output are
 * both computed on-chain, so the calls always act on the Executor's *live* balance.
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
 * balance at the step-supplied offset, tolerating the cap-binding branch's on-chain seize
 * derivation; `'fixed'` calldata is route-bound to an amount committed off-chain and must NOT be
 * spliced — any drift between it and the Executor's actual balance fails closed in `simulate()`.
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
 * Encodes the `Executor.exec_606BaXt(bytes[])` calldata for one liquidation against the **generic**
 * (handler-less) Executor singleton. The single 9-arg `Midnight.liquidate` runs with `receiver =
 * callback = the Executor`, so the seized collateral lands on the Executor and Midnight then calls
 * back into `onLiquidate`. The Executor has no `onLiquidate` Solidity — the sell path + repay
 * approval ride INSIDE `liquidate`'s `data` as the Executor's own callback queue (a `(bytes[] queue,
 * bytes returnData)` blob the `fallback` decodes, runs, and returns `returnData` RAW). The plan's
 * steps chain the seized collateral to the loan token — a plain collateral is one venue swap;
 * exotic collateral is unwrap step(s) then usually a venue swap. Midnight checks that `bytes32`
 * return equals `CALLBACK_SUCCESS`, so the return blob is the raw magic value. Trailing sweeps
 * drain BOTH market tokens plus every intermediate to the EOA — the full-drain invariant of the
 * shared permissionless singleton. Pure — no RPC.
 */
export function encodeLiquidationExec(params: {
  executor: Address
  midnight: Address
  market: Market
  collateralIndex: number
  seizedAssets: bigint
  repaidUnits: bigint
  borrower: Address
  postMaturityMode: boolean
  plan: SwapPlan | null
  recipient: Address
}): Hex {
  const collateral = params.market.collateralParams[params.collateralIndex]
  if (!collateral) {
    throw new Error(`collateralIndex ${params.collateralIndex} out of range for market`)
  }

  const { executor, midnight } = params
  const collateralToken = collateral.token
  const loanToken = params.market.loanToken

  if (
    isBadDebtRealization({
      collateralIndex: params.collateralIndex,
      seizedAssets: params.seizedAssets,
      repaidUnits: params.repaidUnits,
      postMaturityMode: params.postMaturityMode
    })
  ) {
    const liquidateData = encodeFunctionData({
      abi: MidnightAbi,
      functionName: 'liquidate',
      args: [
        params.market,
        BigInt(params.collateralIndex),
        0n,
        0n,
        params.borrower,
        params.postMaturityMode,
        params.recipient,
        zeroAddress,
        '0x'
      ]
    })

    return encodeFunctionData({
      abi: executorAbi,
      functionName: 'exec_606BaXt',
      args: [[ExecutorEncoder.buildCall(midnight, 0n, liquidateData)]]
    })
  }

  if (!params.plan) {
    throw new Error('a swap plan is required when liquidation repays or seizes assets')
  }

  const plan = params.plan

  // The callback queue the Executor runs when Midnight calls back into `onLiquidate`. The seized
  // collateral is already on the Executor (receiver = the Executor); the steps convert it to the
  // loan token, then the repay allowance pair approves Midnight to pull the repay. Balance-based
  // (over-approving by the profit margin) because `repaidUnits` is recomputed on-chain and not
  // staticcall-readable; the residual allowance is inert while the full-drain invariant keeps the
  // Executor's balance at zero between txs.
  const callbackQueue: Hex[] = [
    ...plan.steps.flatMap(step => stepCalls(step, executor)),
    ...approvePair(loanToken, midnight, executor)
  ]

  // The Executor's `fallback` decodes this blob as `(bytes[] queue, bytes returnData)`, runs the
  // queue, and returns `returnData` RAW — Solidity's `fallback(bytes) returns (bytes memory)` special
  // case applies no ABI wrapping. Midnight checks the callback's `bytes32` return against
  // CALLBACK_SUCCESS, so the return blob is the raw 32-byte magic value passed straight as the `bytes`
  // element (NOT `abi.encode`'d — that would prepend an offset word and break the check).
  const callbackData = encodeAbiParameters(
    [{ type: 'bytes[]' }, { type: 'bytes' }],
    [callbackQueue, CALLBACK_SUCCESS]
  )

  const liquidateData = encodeFunctionData({
    abi: MidnightAbi,
    functionName: 'liquidate',
    args: [
      params.market,
      BigInt(params.collateralIndex),
      params.seizedAssets,
      params.repaidUnits,
      params.borrower,
      params.postMaturityMode,
      executor, // receiver — seized collateral lands on the Executor pre-callback
      executor, // callback — Midnight calls Executor.onLiquidate → fallback runs the queue
      callbackData
    ]
  })

  const calls: Hex[] = [
    // The liquidate call carries the callback context so the Executor's `fallback` authorizes
    // `msg.sender == MIDNIGHT` and reads the queue from `data`. `dataIndex` indexes the head of the
    // CALLBACK's calldata, not `liquidate`'s: `data` is the 9th arg (head word 8) of the 10-arg
    // `onLiquidate(caller, id, market, collateralIndex, seizedAssets, repaidUnits, borrower,
    // receiver, data, badDebt)` callback in the vendored Midnight interface.
    ExecutorEncoder.buildCall(midnight, 0n, liquidateData, { sender: midnight, dataIndex: 8n }),
    // Trailing sweeps run AFTER liquidate returns (Midnight's end-of-call repay `transferFrom` happens
    // within `liquidate`), draining BOTH market tokens first (stable ordering for consumers), then
    // any intermediates the step chain introduced — the full-drain invariant.
    skimCall(loanToken, params.recipient, executor),
    skimCall(collateralToken, params.recipient, executor),
    ...intermediateTokens(plan.steps, [loanToken, collateralToken]).map(token =>
      skimCall(token, params.recipient, executor)
    )
  ]

  return encodeFunctionData({ abi: executorAbi, functionName: 'exec_606BaXt', args: [calls] })
}
