import type { Address, Hex } from 'viem'

import { MidnightAbi } from '@repo/contracts'
import { ExecutorEncoder, executorAbi } from 'executooor-viem'
import { encodeAbiParameters, encodeFunctionData, erc20Abi, zeroAddress } from 'viem'

import type { Swap } from '../quotes/types'

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
 * branch passes `seizedAssets = 0` and the contract derives the amount) and the swap output are both
 * computed on-chain, so the calls always act on the Executor's *live* balance.
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
 * Encodes the `Executor.exec_606BaXt(bytes[])` calldata for one liquidation against the **generic**
 * (handler-less) Executor singleton. The single 9-arg `Midnight.liquidate` runs with `receiver =
 * callback = the Executor`, so the seized collateral lands on the Executor and Midnight then calls
 * back into `onLiquidate`. The Executor has no `onLiquidate` Solidity — the swap + repay approval
 * ride INSIDE `liquidate`'s `data` as the Executor's own callback queue (a `(bytes[] queue, bytes
 * returnData)` blob the `fallback` decodes, runs, and returns `returnData` RAW). Midnight checks that
 * `bytes32` return equals `CALLBACK_SUCCESS`, so the return blob is the raw magic value. Two trailing
 * sweeps drain BOTH tokens to the EOA — the full-drain invariant of the shared permissionless
 * singleton. Pure — no RPC.
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
  swap: Swap | null
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

  if (!params.swap) {
    throw new Error('swap is required when liquidation repays or seizes assets')
  }

  const swap = params.swap

  // The swap call is venue-agnostic opaque calldata produced by the venue adapter; the encoder only
  // decides how its input amount is bound. `'balance'` (Uniswap exactInputSingle) splices the
  // Executor's live collateral balance at the venue-supplied offset, tolerating the cap-binding
  // branch's on-chain seize derivation. `'fixed'` (aggregator) calldata is route-bound to a sell
  // amount committed off-chain and must NOT be spliced; any drift between that and the Executor's
  // actual balance fails closed in `simulate()`.
  const swapCall =
    swap.amountIn.source === 'balance'
      ? ExecutorEncoder.buildCall(swap.target, swap.value, swap.callData, undefined, [
          balanceOfPlaceholder(collateralToken, executor, swap.amountIn.offset)
        ])
      : ExecutorEncoder.buildCall(swap.target, swap.value, swap.callData)

  // The callback queue the Executor runs when Midnight calls back into `onLiquidate`. The seized
  // collateral is already on the Executor (receiver = the Executor); this swaps it to the loan token
  // and approves Midnight to pull the repay. The two approval amounts come from the Executor's live
  // `balanceOf` because the contract derives the seized collateral (cap-binding branch) and the
  // recomputed `repaidUnits` on-chain — neither is known when this calldata is built.
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
    // (4) zero then (5) set Midnight's repay allowance. Balance-based (over-approving by the profit
    //     margin) because `repaidUnits` is recomputed on-chain and not staticcall-readable; the
    //     residual allowance is inert while the full-drain invariant keeps the Executor's balance at
    //     zero between txs. Zero-first like the collateral pair: the over-approval leaves a nonzero
    //     Midnight allowance after each liquidation, which would otherwise revert the next approve on
    //     an approve-from-nonzero (USDT-style) loan token.
    ExecutorEncoder.buildCall(
      loanToken,
      0n,
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [midnight, 0n] })
    ),
    ExecutorEncoder.buildCall(
      loanToken,
      0n,
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [midnight, 0n] }),
      undefined,
      [balanceOfPlaceholder(loanToken, executor, ERC20_AMOUNT_OFFSET)]
    )
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
    // within `liquidate`), draining BOTH tokens to the EOA — the full-drain invariant.
    skimCall(loanToken, params.recipient, executor),
    skimCall(collateralToken, params.recipient, executor)
  ]

  return encodeFunctionData({ abi: executorAbi, functionName: 'exec_606BaXt', args: [calls] })
}
