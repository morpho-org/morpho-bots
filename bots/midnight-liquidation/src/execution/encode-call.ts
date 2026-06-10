import type { Address, Hex } from 'viem'

import { MidnightAbi } from '@repo/abis/v2'
import { ExecutorEncoder, executorAbi } from 'executooor-viem'
import { encodeAbiParameters, encodeFunctionData, erc20Abi } from 'viem'

// The Midnight `Market` struct passed to `liquidate`. The bot reads it on-chain from the lens
// (`toMarket(id)`) and re-passes it verbatim.
export type CollateralParams = { token: Address; lltv: bigint; maxLif: bigint; oracle: Address }
export type Market = {
  loanToken: Address
  collateralParams: readonly CollateralParams[]
  maturity: bigint
  rcfThreshold: bigint
  enterGate: Address
  liquidatorGate: Address
}

/**
 * The single-hop swap the Executor's `onLiquidate` runs (seized collateral → loan token). This is
 * the shape the bot ABI-encodes into `liquidate`'s `data`; the Executor handler must decode the
 * same tuple. `fee` is the Uniswap-V3 pool fee tier; `amountOutMinimum` is the slippage bound.
 */
export type SwapStep = {
  router: Address
  tokenIn: Address
  tokenOut: Address
  fee: number
  amountOutMinimum: bigint
}

const SWAP_STEP_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'router', type: 'address' },
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'amountOutMinimum', type: 'uint256' }
    ]
  }
] as const

function encodeSwapStep(step: SwapStep): Hex {
  return encodeAbiParameters(SWAP_STEP_ABI, [
    {
      router: step.router,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      fee: step.fee,
      amountOutMinimum: step.amountOutMinimum
    }
  ])
}

// Drains the Executor's entire balance of `asset` to `recipient`. Mirrors
// `ExecutorEncoder.erc20Skim`: a `transfer(recipient, 0)` whose amount word is overwritten at exec
// time with the Executor's live `balanceOf` (placeholder at offset 4 + 32 = the amount slot), so
// the encoder needs no balance prediction.
function skimCall(asset: Address, recipient: Address, executor: Address): Hex {
  return ExecutorEncoder.buildCall(
    asset,
    0n,
    encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, 0n] }),
    undefined,
    [
      {
        to: asset,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [executor] }),
        offset: 36n,
        length: 32n,
        resOffset: 0n
      }
    ]
  )
}

/**
 * Encodes the `Executor.exec_606BaXt(bytes[])` calldata for one liquidation: a single 9-arg
 * `Midnight.liquidate` with `receiver = callback = the Executor` (so the seized collateral lands on
 * the Executor before the callback, and `onLiquidate` runs there), followed by two trailing sweeps
 * that drain BOTH the loan token and the collateral token to the EOA — the full-drain invariant of
 * the shared permissionless singleton. `data` carries only the swap params; the contract derives the
 * final `repaidUnits`/`seizedAssets` and hands them to the 10-arg `onLiquidate`, whose return must
 * equal `CALLBACK_SUCCESS` (the Executor handler is CRTR-2586). Pure — no RPC.
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
  swapStep: SwapStep
  recipient: Address
}): Hex {
  const collateral = params.market.collateralParams[params.collateralIndex]
  if (!collateral) {
    throw new Error(`collateralIndex ${params.collateralIndex} out of range for market`)
  }

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
      params.executor, // receiver — seized collateral lands on the Executor pre-callback
      params.executor, // callback — onLiquidate runs the swap and approves Midnight
      encodeSwapStep(params.swapStep)
    ]
  })

  const calls: Hex[] = [
    ExecutorEncoder.buildCall(params.midnight, 0n, liquidateData),
    // Trailing sweeps run AFTER liquidate returns (so they don't strip the loan token before
    // Midnight's end-of-call transferFrom). Drain both tokens to the EOA.
    skimCall(params.market.loanToken, params.recipient, params.executor),
    skimCall(collateral.token, params.recipient, params.executor)
  ]

  return encodeFunctionData({ abi: executorAbi, functionName: 'exec_606BaXt', args: [calls] })
}
