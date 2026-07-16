import type { Address } from 'viem'

import { isAddressEqual } from 'viem'

import type { SwapStep } from '../types'

/**
 * A pre-swap converter (ERC4626 redeem, Pendle PT redeem/swap, …). `resolve` returns `null` when
 * it does not apply to `token` — each unwrapper memoizes its own negatives, so repeated probing of
 * plain tokens is cheap. Amounts ride beside the step (they are quoting-internal threading), not
 * in it: the encoder never needs them.
 */
export type Unwrapper = {
  /** Stable name for logging only (e.g. 'erc4626', 'pendle-pt'). */
  kind: string
  resolve: (args: {
    token: Address
    amountIn: bigint
    executor: Address
  }) => Promise<{ step: SwapStep; expectedAmountOut: bigint; amountOutMinimum: bigint } | null>
}

/**
 * Bounds the unwrap chain (a PT whose underlying is itself a vault share is depth 2; anything
 * deeper is pathological). Also the cycle guard — no route optimization, just ordered first-match
 * trials that must terminate.
 */
export const MAX_UNWRAP_DEPTH = 3

/** The unwrap chain plus where it left off: the first token no unwrapper applies to. */
export type UnwrapResolution = {
  steps: SwapStep[]
  /** The token the chain ends on — the venue swap's `tokenIn` (or the loan token itself). */
  token: Address
  /**
   * Worst-case amount of `token` the Executor will hold — each hop threads its
   * `amountOutMinimum` forward so a downstream fixed-amount step can never revert on shortfall.
   */
  amountIn: bigint
}

/**
 * Repeatedly tries each unwrapper in order (first match advances the chain) until none applies,
 * the chain reaches `stopToken` (the loan token — nothing left to sell), or `MAX_UNWRAP_DEPTH`.
 * Unwrapper errors propagate: the caller maps them onto the existing `failed` outcome.
 */
export async function resolveUnwraps(
  unwrappers: readonly Unwrapper[],
  args: { token: Address; amountIn: bigint; executor: Address; stopToken: Address }
): Promise<UnwrapResolution> {
  const { executor, stopToken } = args
  const steps: SwapStep[] = []
  let token = args.token
  let amountIn = args.amountIn

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    if (isAddressEqual(token, stopToken)) break

    let advanced = false
    for (const unwrapper of unwrappers) {
      const result = await unwrapper.resolve({ token, amountIn, executor })
      if (!result) continue
      // A hop that doesn't change the token can never terminate — treat it as "does not apply".
      if (isAddressEqual(result.step.tokenIn, result.step.tokenOut)) continue

      steps.push(result.step)
      token = result.step.tokenOut
      amountIn = result.amountOutMinimum
      advanced = true
      break
    }
    if (!advanced) break
  }

  return { steps, token, amountIn }
}
