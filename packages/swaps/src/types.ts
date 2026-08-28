import type { Address, Hex } from 'viem'

// Pure types shared across the quoting layer and the bots' call encoders. This module has NO runtime
// imports, so an encoder can `import type { Swap }` from here without creating a runtime cycle.

/** A swap venue the operator can route a collateral through. */
export type Venue = 'uniswap-v3' | '0x' | '1inch' | 'lifi' | 'liquidswap'

/**
 * `tokenIn` (collateral) decimals — needed ONLY by decimal-denominated venues (LiquidSwap, whose API
 * takes a human-readable `amountIn`). Base-unit venues (uniswap-v3/0x/1inch/LiFi) ignore it. Optional
 * so those venues and their callers/tests are unaffected; a venue that requires it fails loud.
 */
type TokenInDecimals = { tokenInDecimals?: number }

/**
 * Input to a venue's quote. Raw integer token units throughout — the protocol oracle price converts
 * collateral → loan natively, so no USD/decimals round-trip is needed. `executor` is the
 * taker/from/recipient: the Executor singleton holds the collateral, performs the swap, and receives
 * the loan token for the repay.
 */
export type QuoteParameters = TokenInDecimals & {
  chainId: number
  tokenIn: Address // seized collateral
  tokenOut: Address // loan token
  amountIn: bigint // the seized collateral the Executor will hold — exactly `plan.seizedAssets` (seize-exact)
  /**
   * Max output discount the venue may accept, in bps. **Derived**, not operator-set: the quoting layer
   * computes it from the liquidation's break-even output (`QuoteRequest.minAcceptableAmountOut`) so the
   * resulting floor is economic. Most venues accept only a percentage; the ones that take an absolute
   * minimum read {@link QuoteParameters.minAcceptableAmountOut} instead.
   */
  slippageBps: number
  executor: Address
  /** Oracle-priced expected output (no DEX slippage) — the no-route-quality reference. */
  referenceAmountOut: bigint
  /**
   * The break-even output the quote must clear, in `tokenOut` units.
   *
   * Carried alongside {@link QuoteParameters.slippageBps} because venues express a floor differently:
   * most accept only a percentage, which the quoting layer derives from this, while 1inch takes an
   * ABSOLUTE `minReturn` and so needs the value itself. A venue that can pass this straight through can
   * report the bound faithfully instead of reconstructing it — see {@link Swap.minOutSource}.
   */
  minAcceptableAmountOut: bigint
}

/**
 * An executable swap, ready to drop into the Executor's callback queue. Venue-agnostic: the min-out
 * floor is already encoded inside `callData`, so the encoder never inspects the venue — it only needs
 * to know how the on-chain input amount is bound (`amountIn`).
 */
export type Swap = {
  /** ERC20 `approve` target for `tokenIn`. */
  spender: Address
  /** Swap call target (often === spender). */
  target: Address
  /** Native value to forward (0 for ERC20 → ERC20). */
  value: bigint
  /** Pre-built swap calldata; the min-out floor is already encoded inside it. */
  callData: Hex
  /** How the on-chain input amount is bound. */
  amountIn:
    | { source: 'balance'; offset: bigint } // splice the Executor's live `tokenIn` balance at `offset`
    | { source: 'fixed'; value: bigint } // `callData` commits to `value`; do NOT splice
  /** The venue's quoted output — route-quality check + logging. */
  expectedAmountOut: bigint
  /** The min-out floor encoded in `callData` — logging/observability. */
  amountOutMinimum: bigint
  /**
   * Whether {@link Swap.amountOutMinimum} is the floor the venue actually encoded in `callData`
   * (`'venue'`) or our own reconstruction of what it probably encoded (`'derived'`).
   *
   * Load-bearing, not bookkeeping: an economic floor can only be *checked* against a `'venue'` value.
   * Comparing a `'derived'` one against the floor compares our arithmetic with itself and always
   * agrees, whatever the venue actually baked — so a caller enforcing a floor must reject `'derived'`
   * rather than trust it.
   */
  minOutSource: 'venue' | 'derived'
}

/**
 * Input to a venue's *indicative* price probe. A lighter cousin of {@link QuoteParameters}: no
 * `executor`/`slippageBps`/`referenceAmountOut`, because a probe only measures how much a venue would
 * pay out for a given sell size — it never mints executable calldata, needs no taker, and is compared
 * across venues to rank them (see the venue selector), not sanity-checked against the oracle.
 */
export type PriceParameters = TokenInDecimals & {
  chainId: number
  tokenIn: Address // sell token (collateral)
  tokenOut: Address // buy token (loan)
  amountIn: bigint // the sell size to price
}

/** A venue's indicative output for a {@link PriceParameters} probe — raw integer `tokenOut` units. */
export type PriceQuote = { expectedAmountOut: bigint }

/**
 * One executable conversion call — a vault redeem, a PT redeem/swap, or a venue swap — ready for
 * the Executor callback queue. One shape for unwraps AND the venue swap: the encoders flatten
 * everything into a single queue, so the seam matches the runtime shape. Carries only what the
 * encoder needs; amounts for observability and route-quality live on {@link SwapPlan}.
 */
export type SwapStep = {
  tokenIn: Address
  tokenOut: Address
  /** Call target. */
  target: Address
  /** Native value to forward (0 for ERC20 → ERC20). */
  value: bigint
  /** Pre-built calldata; any min-out floor is already encoded inside it. */
  callData: Hex
  /** How the on-chain input amount is bound — same binding union as {@link Swap.amountIn}. */
  amountIn:
    | { source: 'balance'; offset: bigint } // splice the Executor's live `tokenIn` balance at `offset`
    | { source: 'fixed'; value: bigint } // `callData` commits to `value`; do NOT splice
  /**
   * Approve `tokenIn` to this spender (zero-then-balance pair) before the call. Omitted when the
   * target burns the caller's own balance (ERC4626 redeem).
   */
  approvalSpender?: Address
}

/**
 * The full sell path for one liquidation: ordered steps chaining `tokenIn` → `tokenOut` until the
 * loan token, so `steps.at(-1).tokenOut` is the loan token whenever there is a last step. Plain
 * collateral is one venue-swap step; exotic collateral is unwrap step(s) then usually a venue-swap
 * step — but none when the unwrap chain already ends in the loan token (PT-USDC collateral / USDC
 * loan is the norm there, not an edge case).
 *
 * **`steps` may be empty**, and an empty plan is a real plan, not a missing one: the collateral token
 * already IS the loan token, so the seized assets need no conversion before the repay (Midnight's
 * loan-as-collateral slots). Encoders must treat a zero-step plan as "convert nothing" — the repay
 * approval and the sweeps still apply — and must not confuse it with `null`, which means no route was
 * found. `expectedAmountOut` and `amountOutMinimum` are then both the seized amount itself.
 */
export type SwapPlan = {
  steps: SwapStep[]
  /** Final loan-token output, expected — route-quality + logging only. */
  expectedAmountOut: bigint
  /** Final loan-token output, worst-case — logging/observability. */
  amountOutMinimum: bigint
}

/**
 * Why an executable quote could not be produced. Two classes, and callers must not conflate them:
 * `timeout`/`rate_limited`/`api_error`/`no_route`/`bad_route` are failures, and suppressing a position
 * that keeps producing them bounds API + RPC usage. `floor_unmet` is an economic verdict — the venue
 * quoted fine, its guaranteed output just did not clear the liquidation's break-even repay — and both
 * sides of that comparison move on a ten-second scale, so it says almost nothing about the next
 * attempt and must not drive backoff.
 */
export type QuoteFailureReason =
  | 'timeout'
  | 'rate_limited'
  | 'no_route'
  | 'api_error'
  | 'bad_route'
  | 'floor_unmet'

/**
 * The result of resolving a swap for one liquidatable position:
 * - `swap` — an executable {@link SwapPlan} to encode + simulate;
 * - `no_config` — the operator has not configured this collateral (a coverage gap, not a failure; no
 *   API call was made) → skip with `config.no_swap_path`;
 * - `failed` — no executable quote: a transient quote/route failure (API down, no route, or the route
 *   fails the oracle sanity check) → skip and back the position off, or an economic `floor_unmet`
 *   verdict → skip WITHOUT backing off (see {@link QuoteFailureReason}).
 */
export type QuoteOutcome =
  | { kind: 'swap'; plan: SwapPlan }
  | { kind: 'no_config' }
  | { kind: 'failed'; reason: QuoteFailureReason }

/** Thrown by adapters/HTTP client to carry a classified {@link QuoteFailureReason}. */
export class QuoteError extends Error {
  readonly reason: QuoteFailureReason

  constructor(reason: QuoteFailureReason, message: string) {
    super(message)
    this.name = 'QuoteError'
    this.reason = reason
  }
}
