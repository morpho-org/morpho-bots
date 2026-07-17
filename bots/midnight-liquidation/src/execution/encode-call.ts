import type { SwapPlan } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { MidnightAbi } from '@repo/contracts'
import { approvePair, intermediateTokens, skimCall, stepCalls } from '@repo/swaps'
import { ExecutorEncoder, executorAbi } from 'executooor-viem'
import { encodeAbiParameters, encodeFunctionData, zeroAddress } from 'viem'

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
