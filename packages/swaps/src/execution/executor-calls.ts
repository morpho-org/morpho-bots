import type { Address, Hex } from 'viem'

import { ExecutorEncoder } from 'executooor-viem'
import { encodeFunctionData, erc20Abi, getAddress, isAddressEqual } from 'viem'

import type { SwapStep } from '../types'

// `approve(spender, amount)` / `transfer(recipient, amount)`: the amount word sits at byte offset
// 4 (selector) + 32 (the address word).
const ERC20_AMOUNT_OFFSET = 36n

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
export function skimCall(asset: Address, recipient: Address, executor: Address): Hex {
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
export function approvePair(token: Address, spender: Address, executor: Address): Hex[] {
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
export function stepCalls(step: SwapStep, executor: Address): Hex[] {
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
export function intermediateTokens(
  steps: readonly SwapStep[],
  exclude: readonly Address[]
): Address[] {
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
